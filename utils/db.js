const { MongoClient } = require('mongodb');

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    // If the database connection is already cached, reuse it
    if (cachedClient && cachedDb) {
        return { client: cachedClient, db: cachedDb };
    }

    const uri = process.env.MONGODB_URI;
    if (!uri) {
        throw new Error('MONGODB_URI is not defined in the environment variables (.env)');
    }

    // Set connection options (optimized for serverless & local)
    const client = new MongoClient(uri, {
        maxPoolSize: 10,
        minPoolSize: 1
    });

    await client.connect();
    const db = client.db(process.env.DB_NAME || 'sewalokerbox');

    cachedClient = client;
    cachedDb = db;

    console.log('MongoDB: ✓ Database connection successfully established');
    return { client, db };
}

module.exports = { connectToDatabase };
