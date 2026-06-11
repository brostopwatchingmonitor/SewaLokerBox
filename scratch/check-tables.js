require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function checkTables() {
    try {
        const res = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);
        console.log('PostgreSQL Tables:', res.rows.map(r => r.table_name));
    } catch (err) {
        console.error('Error fetching tables:', err);
    } finally {
        await pool.end();
    }
}

checkTables();
