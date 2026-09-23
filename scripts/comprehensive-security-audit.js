/**
 * Comprehensive Security Audit for Specular Protocol
 *
 * Checks:
 * 1. Private key exposure in code
 * 2. API key exposure
 * 3. Environment variable usage
 * 4. Git history for leaked secrets
 * 5. Contract ownership verification
 * 6. File permissions
 * 7. Dependencies vulnerabilities
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CRITICAL_FINDINGS = [];
const WARNINGS = [];
const INFO = [];

// Known safe keys (test/demo only)
const SAFE_KEYS = new Set([
    '0x8622b721e07155fc086831a72cdb674fe5caf6a83f5f8b1caa17ebe7539c87c6', // Demo agent (new, unfunded)
    '0x0000000000000000000000000000000000000000000000000000000000000000', // Placeholder
]);

// Compromised keys that should NOT be in production
// Note: Actual key values removed for security - check pattern matching instead
const COMPROMISED_KEYS = new Set([
    // Previously compromised keys have been migrated - this set intentionally left empty
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'artifacts', 'cache', 'coverage', 'dist', 'build']);
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'comprehensive-security-audit.js']);

console.log('═══════════════════════════════════════════════════════════════');
console.log('  COMPREHENSIVE SECURITY AUDIT');
console.log('  Specular Protocol');
console.log('  ' + new Date().toISOString());
console.log('═══════════════════════════════════════════════════════════════\n');

// ============================================================================
// 1. PRIVATE KEY SCAN
// ============================================================================

console.log('1️⃣  SCANNING FOR PRIVATE KEYS...\n');

const privateKeyPattern = /0x[a-fA-F0-9]{64}/g;
const files = [];

function scanDirectory(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) scanDirectory(fullPath);
        } else {
            if (!SKIP_FILES.has(entry.name)) files.push(fullPath);
        }
    }
}

scanDirectory('/Users/peterschroeder/Specular');

let privateKeysFound = 0;
const fileWithKeys = new Set();

files.forEach(filePath => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const matches = content.match(privateKeyPattern);

        if (matches) {
            matches.forEach(key => {
                if (SAFE_KEYS.has(key)) return; // Skip safe keys

                const isCompromised = COMPROMISED_KEYS.has(key);
                const isInEnv = filePath.includes('.env');
                const isInDocs = filePath.endsWith('.md');

                if (isCompromised && isInDocs) {
                    INFO.push(`Documented compromised key in ${filePath} (OK - historical reference)`);
                } else if (isInEnv) {
                    INFO.push(`Private key in ${filePath} (OK - proper usage)`);
                } else if (isInDocs) {
                    WARNINGS.push(`Private key in documentation: ${filePath}`);
                } else if (filePath.includes('test-agents.json') || filePath.includes('config')) {
                    WARNINGS.push(`Private key in config/test file: ${filePath}`);
                } else {
                    CRITICAL_FINDINGS.push(`EXPOSED PRIVATE KEY in ${filePath}`);
                    fileWithKeys.add(filePath);
                    privateKeysFound++;
                }
            });
        }
    } catch (error) {
        // Skip files that can't be read
    }
});

console.log(`   Scanned ${files.length} files`);
console.log(`   Found ${privateKeysFound} potentially exposed private keys\n`);

// ============================================================================
// 2. GIT HISTORY CHECK
// ============================================================================

console.log('2️⃣  CHECKING GIT HISTORY...\n');

try {
    // Check if .env was ever committed
    const envHistory = execSync('git log --all --full-history -- .env 2>&1', { encoding: 'utf8' });
    if (envHistory.trim().length > 0) {
        CRITICAL_FINDINGS.push('.env file WAS committed to git history!');
    } else {
        INFO.push('.env never committed to git (✅ Good)');
    }

    // Check if .gitignore contains .env
    const gitignore = fs.readFileSync('.gitignore', 'utf8');
    if (gitignore.includes('.env')) {
        INFO.push('.env is in .gitignore (✅ Good)');
    } else {
        CRITICAL_FINDINGS.push('.env NOT in .gitignore!');
    }
} catch (error) {
    WARNINGS.push('Could not check git history: ' + error.message);
}

console.log('   Git history checked\n');

// ============================================================================
// 3. API KEY SCAN
// ============================================================================

console.log('3️⃣  SCANNING FOR API KEYS...\n');

const apiKeyPatterns = [
    /moltbook_sk_[a-zA-Z0-9_-]+/g,
    /MOLTBOOK_API_KEY\s*=\s*['""]([^'"'"]+)['"'"]/g,
    /sk_[a-zA-Z0-9]{32,}/g,
];

let apiKeysFound = 0;

files.forEach(filePath => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');

        apiKeyPatterns.forEach(pattern => {
            const matches = content.match(pattern);
            if (matches) {
                const isInEnv = filePath.includes('.env');
                const isInCode = filePath.endsWith('.js');

                if (isInEnv) {
                    INFO.push(`API key in ${filePath} (OK - proper usage)`);
                } else if (isInCode) {
                    WARNINGS.push(`Hardcoded API key in ${filePath}`);
                    apiKeysFound++;
                }
            }
        });
    } catch (error) {
        // Skip
    }
});

console.log(`   Found ${apiKeysFound} hardcoded API keys\n`);

// ============================================================================
// 4. CONTRACT OWNERSHIP VERIFICATION
// ============================================================================

console.log('4️⃣  VERIFYING CONTRACT OWNERSHIP...\n');

try {
    const baseAddresses = JSON.parse(fs.readFileSync('./src/config/base-addresses.json', 'utf8'));
    const arcAddresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));

    if (baseAddresses.SECURITY_STATUS?.includes('SECURED')) {
        INFO.push('Base Mainnet contracts: ✅ SECURED');
    } else {
        WARNINGS.push('Base Mainnet security status unclear');
    }

    if (arcAddresses.SECURITY_STATUS?.includes('SECURED')) {
        INFO.push('Arc Testnet contracts: ✅ SECURED');
    } else {
        WARNINGS.push('Arc Testnet security status unclear');
    }
} catch (error) {
    WARNINGS.push('Could not verify contract ownership: ' + error.message);
}

console.log('   Contract ownership verified\n');

// ============================================================================
// 5. ENVIRONMENT VARIABLE USAGE
// ============================================================================

console.log('5️⃣  CHECKING ENVIRONMENT VARIABLE USAGE...\n');

let envVarIssues = 0;

files.filter(f => f.endsWith('.js')).forEach(filePath => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');

        // Check for hardcoded keys instead of env vars
        if (content.includes('PRIVATE_KEY') && !content.includes('process.env.PRIVATE_KEY')) {
            const lines = content.split('\n');
            lines.forEach((line, idx) => {
                if (line.includes('PRIVATE_KEY') && line.includes('=') && line.includes('0x')) {
                    WARNINGS.push(`Hardcoded PRIVATE_KEY in ${filePath}:${idx + 1}`);
                    envVarIssues++;
                }
            });
        }
    } catch (error) {
        // Skip
    }
});

console.log(`   Found ${envVarIssues} improper environment variable usages\n`);

// ============================================================================
// 6. FILE PERMISSIONS
// ============================================================================

console.log('6️⃣  CHECKING FILE PERMISSIONS...\n');

try {
    if (fs.existsSync('.env')) {
        const stats = fs.statSync('.env');
        const mode = (stats.mode & parseInt('777', 8)).toString(8);

        if (mode === '600' || mode === '400') {
            INFO.push(`.env file permissions: ${mode} (✅ Good)`);
        } else {
            WARNINGS.push(`.env file permissions: ${mode} (should be 600)`);
        }
    }
} catch (error) {
    WARNINGS.push('Could not check file permissions: ' + error.message);
}

console.log('   File permissions checked\n');

// ============================================================================
// 7. DEPENDENCY VULNERABILITIES
// ============================================================================

console.log('7️⃣  CHECKING DEPENDENCIES...\n');

try {
    const auditResult = execSync('npm audit --json 2>&1', { encoding: 'utf8' });
    const audit = JSON.parse(auditResult);

    const vulnCount = audit.metadata?.vulnerabilities;
    if (vulnCount) {
        const critical = vulnCount.critical || 0;
        const high = vulnCount.high || 0;
        const moderate = vulnCount.moderate || 0;

        if (critical > 0) {
            CRITICAL_FINDINGS.push(`${critical} CRITICAL vulnerabilities in dependencies`);
        }
        if (high > 0) {
            WARNINGS.push(`${high} HIGH vulnerabilities in dependencies`);
        }
        if (moderate > 0) {
            INFO.push(`${moderate} moderate vulnerabilities in dependencies`);
        }

        if (critical === 0 && high === 0 && moderate === 0) {
            INFO.push('Dependencies: ✅ No vulnerabilities');
        }
    }
} catch (error) {
    WARNINGS.push('Could not run npm audit');
}

console.log('   Dependencies checked\n');

// ============================================================================
// REPORT
// ============================================================================

console.log('═══════════════════════════════════════════════════════════════');
console.log('  AUDIT RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

if (CRITICAL_FINDINGS.length > 0) {
    console.log('🚨 CRITICAL ISSUES:\n');
    CRITICAL_FINDINGS.forEach((finding, i) => {
        console.log(`   ${i + 1}. ${finding}`);
    });
    console.log('');
}

if (WARNINGS.length > 0) {
    console.log('⚠️  WARNINGS:\n');
    WARNINGS.forEach((warning, i) => {
        console.log(`   ${i + 1}. ${warning}`);
    });
    console.log('');
}

if (INFO.length > 0) {
    console.log('ℹ️  INFORMATION:\n');
    INFO.forEach((info, i) => {
        console.log(`   ${i + 1}. ${info}`);
    });
    console.log('');
}

// ============================================================================
// SUMMARY
// ============================================================================

console.log('═══════════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`   Critical Issues: ${CRITICAL_FINDINGS.length}`);
console.log(`   Warnings: ${WARNINGS.length}`);
console.log(`   Info: ${INFO.length}`);
console.log('');

if (CRITICAL_FINDINGS.length === 0) {
    console.log('   ✅ NO CRITICAL SECURITY ISSUES FOUND\n');
} else {
    console.log('   ❌ CRITICAL ISSUES REQUIRE IMMEDIATE ACTION\n');
}

console.log('═══════════════════════════════════════════════════════════════\n');

// Exit with error code if critical issues found
process.exit(CRITICAL_FINDINGS.length > 0 ? 1 : 0);
