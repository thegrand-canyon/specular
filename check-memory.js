#!/usr/bin/env node

// Check and report actual Node.js memory configuration
const v8 = require('v8');
const os = require('os');

console.log('='.repeat(60));
console.log('NODE.JS MEMORY CONFIGURATION CHECK');
console.log('='.repeat(60));

console.log('\n📊 System Resources:');
console.log('  Total System Memory:', (os.totalmem() / 1024 / 1024 / 1024).toFixed(2), 'GB');
console.log('  Free System Memory:', (os.freemem() / 1024 / 1024 / 1024).toFixed(2), 'GB');

console.log('\n🔧 Node.js Configuration:');
console.log('  Node Version:', process.version);
console.log('  NODE_OPTIONS:', process.env.NODE_OPTIONS || 'Not set');

console.log('\n💾 V8 Heap Statistics:');
const heapStats = v8.getHeapStatistics();
console.log('  Heap Size Limit:', (heapStats.heap_size_limit / 1024 / 1024).toFixed(2), 'MB');
console.log('  Total Available Size:', (heapStats.total_available_size / 1024 / 1024).toFixed(2), 'MB');
console.log('  Total Heap Size:', (heapStats.total_heap_size / 1024 / 1024).toFixed(2), 'MB');
console.log('  Used Heap Size:', (heapStats.used_heap_size / 1024 / 1024).toFixed(2), 'MB');

console.log('\n🎯 Expected vs Actual:');
const expectedMB = 512;
const actualMB = (heapStats.heap_size_limit / 1024 / 1024).toFixed(2);
const percentOfExpected = ((actualMB / expectedMB) * 100).toFixed(1);

console.log('  Expected Heap Limit:', expectedMB, 'MB');
console.log('  Actual Heap Limit:', actualMB, 'MB');
console.log('  Percentage:', percentOfExpected + '%');

if (actualMB < 100) {
  console.log('\n⚠️  WARNING: Heap limit is VERY LOW!');
  console.log('  This will cause memory pressure and crashes.');
  console.log('  Railway may be overriding --max-old-space-size flag.');
}

console.log('\n' + '='.repeat(60));
console.log('Starting application...\n');

// Start the actual application
require('./src/api/MultiNetworkAPI.js');
