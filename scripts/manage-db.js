import { rmSync, existsSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { config } from '../src/config/index.js';

const action = process.argv[2];

if (action === 'clear') {
  console.log('🚀 Starting deep cleanup...');

  // 1. Clear Sessions
  const sessionsPath = resolve(config.sessionsDir);
  if (existsSync(sessionsPath)) {
    console.log(`📁 Cleaning sessions in: ${sessionsPath}`);
    const folders = readdirSync(sessionsPath);
    for (const folder of folders) {
      const fullPath = join(sessionsPath, folder);
      try {
        rmSync(fullPath, { recursive: true, force: true });
        console.log(`   ✅ Deleted session folder: ${folder}`);
      } catch (err) {
        console.error(`   ❌ Failed to delete ${folder}: ${err.message}`);
      }
    }
  }

  // 2. Clear Database
  const dbPath = resolve(config.dbPath);
  const dbFiles = [
    dbPath,
    `${dbPath}-shm`,
    `${dbPath}-wal`
  ];

  console.log('🗄️  Deleting database files...');
  for (const file of dbFiles) {
    if (existsSync(file)) {
      try {
        rmSync(file, { force: true });
        console.log(`   ✅ Deleted: ${file}`);
      } catch (err) {
        console.error(`   ❌ Failed to delete ${file}: ${err.message}`);
      }
    }
  }

  console.log('\n✨ Cleanup completed! Database and sessions have been reset.');
  console.log('ℹ️  Run "npm start" or "npm run dev" to start fresh and recreate the database.');

} else {
  console.log('Usage: node scripts/manage-db.js clear');
}
