/**
 * Database connection pool
 */

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.database.url
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
