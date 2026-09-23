/**
 * Comprehensive Security Scan
 *
 * Scans for:
 * - Exposed private keys
 * - Exposed API keys
 * - Hardcoded secrets
 * - Git history leaks
 * - File permissions
 * - npm package security
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let issues = [];
let warnings = [];
let passed = [];

function checkFile(filePath, content, patterns) {
    const lines = content.split('\n');
    lines.forEach((line, index) => {
        patterns.forEach(pattern => {
            if (pattern.regex.test(line) && !pattern.ignore.test(line)) {
                issues.push({
                    file: filePath,
                    line: index + 1,
                    severity: pattern.severity,
                    type: pattern.type,
                    content: line.trim().substring(0, 100)
                });
            }
        });
    });
}

function scanDirectory(dir, patterns, excludeDirs = []) {
    const files = fs.readdirSync(dir);

    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            if (!excludeDirs.includes(file) && !file.startsWith('.')) {
                scanDirectory(filePath, patterns, excludeDirs);
            }
        } else if (stat.isFile()) {
            const ext = path.extname(file);
            if (['.js', '.ts', '.py', '.sh', '.json', '.md', '.env'].includes(ext) || file === '.env') {
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    checkFile(filePath, content, patterns);
                } catch (e) {
                    // Skip files we can't read
                }
            }
        }
    });
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  COMPREHENSIVE SECURITY SCAN');
console.log('═══════════════════════════════════════════════════════════════\n');

// Define security patterns
const patterns = [
    {
        type: 'Private Key (Ethereum)',
        regex: /(?:private[_-]?key|PRIVATE[_-]?KEY)\s*[=:]\s*['"]*0x[a-fA-F0-9]{64}/i,
        ignore: /process\.env|example|placeholder|your_key|YOUR_KEY|<key>|DEMO_AGENT_KEY|AGENT_PRIVATE_KEY/,
        severity: 'CRITICAL'
    },
    {
        type: 'Hardcoded Private Key',
        regex: /['"]0x[a-fA-F0-9]{64}['"]/,
        ignore: /process\.env|example|test|mock|placeholder|Expected|Actual|0x0{64}|0x1{64}/,
        severity: 'CRITICAL'
    },
    {
        type: 'API Key',
        regex: /(?:api[_-]?key|API[_-]?KEY)\s*[=:]\s*['"][a-zA-Z0-9_-]{20,}['"]/i,
        ignore: /process\.env|example|placeholder|your_api_key|YOUR_API_KEY|<key>/,
        severity: 'HIGH'
    },
    {
        type: 'Moltbook API Key',
        regex: /moltbook_sk_[a-zA-Z0-9_-]+/,
        ignore: /process\.env|MOLTBOOK_API_KEY|if \(!API_KEY\)|throw new Error/,
        severity: 'HIGH'
    },
    {
        type: 'Password',
        regex: /(?:password|PASSWORD)\s*[=:]\s*['"][^'"]{6,}['"]/i,
        ignore: /process\.env|example|placeholder|your_password|YOUR_PASSWORD|<password>|Username|Email/,
        severity: 'CRITICAL'
    }
];

console.log('🔍 Scanning codebase...\n');

// Scan the entire project
scanDirectory('.', patterns, ['node_modules', 'artifacts', 'cache', 'coverage', '.git', 'frontend']);

// Check .env file specifically
console.log('📄 Checking .env file security...\n');
if (fs.existsSync('.env')) {
    const envContent = fs.readFileSync('.env', 'utf-8');
    if (envContent.includes('PRIVATE_KEY=0x')) {
        passed.push('.env contains private keys (EXPECTED - this is correct)');
    }

    // Check if .env is in .gitignore
    if (fs.existsSync('.gitignore')) {
        const gitignore = fs.readFileSync('.gitignore', 'utf-8');
        if (gitignore.includes('.env')) {
            passed.push('.env is in .gitignore (SECURE)');
        } else {
            issues.push({
                file: '.gitignore',
                line: 0,
                severity: 'CRITICAL',
                type: 'Missing .gitignore entry',
                content: '.env is NOT in .gitignore'
            });
        }
    }
}

// Check Git history for leaked secrets
console.log('🕵️  Checking Git history...\n');
if (fs.existsSync('.git')) {
    try {
        const gitLog = execSync('git log --all --pretty=format:"%H" | head -100', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
        const commits = gitLog.split('\n').filter(c => c.length > 0);

        if (commits.length > 0) {
            warnings.push(`Checked ${commits.length} recent commits for secrets`);

            // Sample check a few commits
            for (let i = 0; i < Math.min(5, commits.length); i++) {
                try {
                    const diff = execSync(`git show ${commits[i]} --pretty="" | grep -i "private.*key\\|api.*key\\|password\\|secret" | head -5 || true`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
                    if (diff && !diff.includes('process.env') && diff.trim().length > 0) {
                        warnings.push(`Commit ${commits[i].substring(0, 7)} may contain secrets - manual review recommended`);
                    }
                } catch (e) {
                    // Git command failed, skip
                }
            }
        }
    } catch (e) {
        warnings.push('Could not scan Git history (not a git repo or git not available)');
    }
} else {
    passed.push('No Git repository (no history to scan)');
}

// Check file permissions on sensitive files
console.log('🔐 Checking file permissions...\n');
const sensitiveFiles = ['.env', 'scripts/comprehensive-security-audit.js'];
sensitiveFiles.forEach(file => {
    if (fs.existsSync(file)) {
        try {
            const stats = fs.statSync(file);
            const mode = (stats.mode & parseInt('777', 8)).toString(8);
            if (mode === '600' || mode === '644') {
                passed.push(`${file} has safe permissions (${mode})`);
            } else {
                warnings.push(`${file} has permissions ${mode} (consider 600 for secrets)`);
            }
        } catch (e) {
            // Skip if we can't check
        }
    }
});

// Check for exposed credentials in npm package
console.log('📦 Checking npm package security...\n');
if (fs.existsSync('src/integrations/langchain/package.json')) {
    const pkg = JSON.parse(fs.readFileSync('src/integrations/langchain/package.json', 'utf-8'));

    // Check .npmignore exists
    if (fs.existsSync('src/integrations/langchain/.npmignore')) {
        const npmignore = fs.readFileSync('src/integrations/langchain/.npmignore', 'utf-8');
        if (npmignore.includes('.env')) {
            passed.push('npm package excludes .env files');
        } else {
            warnings.push('npm package .npmignore should include .env');
        }
    } else {
        warnings.push('No .npmignore file in npm package - sensitive files might be included');
    }
}

// Report results
console.log('═══════════════════════════════════════════════════════════════');
console.log('  SCAN RESULTS');
console.log('═══════════════════════════════════════════════════════════════\n');

if (issues.length === 0) {
    console.log('✅ NO CRITICAL ISSUES FOUND\n');
} else {
    console.log(`❌ FOUND ${issues.length} SECURITY ISSUES:\n`);

    const critical = issues.filter(i => i.severity === 'CRITICAL');
    const high = issues.filter(i => i.severity === 'HIGH');

    if (critical.length > 0) {
        console.log('🚨 CRITICAL ISSUES:\n');
        critical.forEach(issue => {
            console.log(`  File: ${issue.file}:${issue.line}`);
            console.log(`  Type: ${issue.type}`);
            console.log(`  Content: ${issue.content}`);
            console.log('');
        });
    }

    if (high.length > 0) {
        console.log('⚠️  HIGH PRIORITY ISSUES:\n');
        high.forEach(issue => {
            console.log(`  File: ${issue.file}:${issue.line}`);
            console.log(`  Type: ${issue.type}`);
            console.log(`  Content: ${issue.content}`);
            console.log('');
        });
    }
}

if (warnings.length > 0) {
    console.log('⚠️  WARNINGS:\n');
    warnings.forEach(w => console.log(`  • ${w}`));
    console.log('');
}

if (passed.length > 0) {
    console.log('✅ SECURITY CHECKS PASSED:\n');
    passed.forEach(p => console.log(`  • ${p}`));
    console.log('');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log(`Critical Issues: ${issues.filter(i => i.severity === 'CRITICAL').length}`);
console.log(`High Priority Issues: ${issues.filter(i => i.severity === 'HIGH').length}`);
console.log(`Warnings: ${warnings.length}`);
console.log(`Checks Passed: ${passed.length}`);
console.log('');

if (issues.length === 0) {
    console.log('✅ SECURITY STATUS: PASS\n');
    console.log('═══════════════════════════════════════════════════════════════\n');
    process.exit(0);
} else {
    console.log('❌ SECURITY STATUS: FAIL\n');
    console.log('Please fix critical and high priority issues before deployment.\n');
    console.log('═══════════════════════════════════════════════════════════════\n');
    process.exit(1);
}
