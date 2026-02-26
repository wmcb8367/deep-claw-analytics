#!/bin/bash

# Deep Claw Analytics Setup Script

set -e

echo "🦞 Deep Claw Analytics Setup"
echo "=============================="
echo ""

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo "❌ PostgreSQL not found. Please install PostgreSQL first:"
    echo "   macOS: brew install postgresql"
    echo "   Ubuntu: sudo apt install postgresql"
    exit 1
fi

echo "✅ PostgreSQL found"

# Check if .env exists
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cp .env.example .env
    echo "⚠️  Please edit .env with your database URL and settings"
    echo "   nano .env"
    read -p "Press Enter when done..."
fi

echo "✅ .env configured"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

echo "✅ Dependencies installed"

# Create database if needed
read -p "Create database? (y/n): " create_db
if [ "$create_db" = "y" ]; then
    read -p "Database name (default: deepclaw_analytics): " db_name
    db_name=${db_name:-deepclaw_analytics}
    
    echo "Creating database $db_name..."
    createdb $db_name || echo "Database may already exist"
    
    echo "✅ Database created"
fi

# Run migrations
echo "🔄 Running database migrations..."
npm run db:migrate

echo "✅ Migrations complete"

# Test connection
echo "🔍 Testing database connection..."
node -e "
const db = require('./src/db');
db.query('SELECT NOW()').then(() => {
  console.log('✅ Database connection successful');
  process.exit(0);
}).catch(err => {
  console.error('❌ Database connection failed:', err.message);
  process.exit(1);
});
"

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Start API server: npm start"
echo "2. Start relay listener: npm run relay:start"
echo "3. Open http://localhost:3000 to sign up"
echo ""
echo "🦞 Happy analyzing!"
