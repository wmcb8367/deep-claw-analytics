#!/usr/bin/env node
/**
 * Simple migration runner
 * Usage: node sql/run-migration.js migrations/001_timing_analytics.sql
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function runMigration(filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  
  try {
    console.log(`Running migration: ${path.basename(filePath)}`);
    await pool.query(sql);
    console.log('✅ Migration completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

const migrationFile = process.argv[2];
if (!migrationFile) {
  console.error('Usage: node run-migration.js <migration-file.sql>');
  process.exit(1);
}

runMigration(migrationFile);
