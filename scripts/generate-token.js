#!/usr/bin/env node
/**
 * Generate a long-lived API token for a user
 * Usage: node scripts/generate-token.js <user_id> <token_name> [scopes]
 */

const { Pool } = require('pg');
const crypto = require('crypto');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function generateToken() {
  const prefix = 'dc';
  const randomPart = crypto.randomBytes(16).toString('hex');
  const checksum = crypto.randomBytes(16).toString('hex');
  return `${prefix}_${randomPart}_${checksum}`;
}

async function createToken(userId, tokenName, scopes = ['read:metrics', 'read:events']) {
  const token = generateToken();
  
  try {
    const result = await pool.query(
      `INSERT INTO api_tokens (user_id, token, name, scopes)
       VALUES ($1, $2, $3, $4)
       RETURNING id, token, name, scopes, created_at`,
      [userId, token, tokenName, scopes]
    );
    
    const tokenData = result.rows[0];
    
    console.log('\n✅ Token created successfully!\n');
    console.log('─'.repeat(60));
    console.log(`Token ID:    ${tokenData.id}`);
    console.log(`Token Name:  ${tokenData.name}`);
    console.log(`User ID:     ${userId}`);
    console.log(`Scopes:      ${tokenData.scopes.join(', ')}`);
    console.log(`Created:     ${tokenData.created_at}`);
    console.log('─'.repeat(60));
    console.log(`\nAPI Token:\n${tokenData.token}`);
    console.log('\n⚠️  Save this token securely! It won\'t be shown again.\n');
    
  } catch (error) {
    console.error('❌ Error creating token:', error.message);
    throw error;
  } finally {
    await pool.end();
  }
}

const userId = parseInt(process.argv[2]);
const tokenName = process.argv[3];
const scopesArg = process.argv[4];

if (!userId || !tokenName) {
  console.error('Usage: node generate-token.js <user_id> <token_name> [scopes]');
  console.error('');
  console.error('Examples:');
  console.error('  node generate-token.js 1 "Sebastian OpenClaw Access"');
  console.error('  node generate-token.js 1 "Read-only Token" "read:metrics,read:events"');
  process.exit(1);
}

const scopes = scopesArg 
  ? scopesArg.split(',').map(s => s.trim())
  : ['read:metrics', 'read:events', 'read:insights'];

createToken(userId, tokenName, scopes);
