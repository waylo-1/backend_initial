/**
 * Supabase client for Waylo
 * 
 * Database Schema:
 * 
 * CREATE TABLE guides (
 *   id TEXT PRIMARY KEY,
 *   task_name TEXT NOT NULL,
 *   language TEXT NOT NULL DEFAULT 'hi',
 *   steps JSONB NOT NULL,
 *   created_at TIMESTAMP DEFAULT NOW(),
 *   expires_at TIMESTAMP NOT NULL
 * );
 */

const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  console.error('Missing Supabase credentials in environment variables');
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = supabase;
