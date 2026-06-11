require('dotenv').config();
const { Pool } = require('pg');
const { MongoClient, ObjectId } = require('mongodb');

// Verify connection parameters
const postgresConnectionString = process.env.DATABASE_URL;
const mongodbUri = process.env.MONGODB_URI;

if (!postgresConnectionString || !mongodbUri) {
    console.error('Error: DATABASE_URL and MONGODB_URI must be set in your .env file.');
    process.exit(1);
}

const pgPool = new Pool({
    connectionString: postgresConnectionString,
    ssl: { rejectUnauthorized: false }
});

const mongoClient = new MongoClient(mongodbUri);

async function runMigration() {
    try {
        console.log('Connecting to databases...');
        await mongoClient.connect();
        const mongoDb = mongoClient.db();

        console.log('MongoDB: Connected successfully.');

        // Clean target collections to make it repeatable
        console.log('Clearing existing target collections...');
        await mongoDb.collection('users').deleteMany({});
        await mongoDb.collection('locker_stations').deleteMany({});
        await mongoDb.collection('transactions').deleteMany({});
        await mongoDb.collection('topup_transactions').deleteMany({});

        // 1. MIGRATE USERS
        console.log('1. Fetching users from PostgreSQL...');
        const usersResult = await pgPool.query('SELECT * FROM "User"');
        console.log(`Fetched ${usersResult.rows.length} users.`);

        const userMap = new Map(); // Postgres UUID -> Mongo ObjectId
        const mongoUsers = usersResult.rows.map(row => {
            const mongoId = new ObjectId();
            userMap.set(row.id, mongoId);
            
            const userDoc = {
                _id: mongoId,
                legacy_id: row.id,
                full_name: row.full_name,
                security: {
                    password: row.password || ''
                },
                wallet_balance: parseFloat(row.balance || 0),
                created_at: new Date(row.createdAt || Date.now()),
                updated_at: new Date()
            };

            if (row.nfc_uid) userDoc.nfc_uid = row.nfc_uid;
            if (row.email) userDoc.email = row.email;
            if (row.phone_number) userDoc.phone_number = row.phone_number;

            return userDoc;
        });

        if (mongoUsers.length > 0) {
            await mongoDb.collection('users').insertMany(mongoUsers);
            console.log('✓ Users collection populated.');
        }

        // 2. MIGRATE LOCKERS (Create default station and embed boxes)
        console.log('2. Fetching lockers from PostgreSQL...');
        const lockersResult = await pgPool.query('SELECT * FROM "Locker"');
        console.log(`Fetched ${lockersResult.rows.length} lockers.`);

        const lockerMap = new Map(); // Postgres Locker ID (Int) -> Mongo box_id (ObjectId)
        const defaultStationId = new ObjectId();

        const embeddedBoxes = lockersResult.rows.map(row => {
            const boxId = new ObjectId();
            lockerMap.set(row.id, boxId);
            return {
                box_id: boxId,
                legacy_locker_id: row.id,
                box_number: `BOX-${row.id}`,
                size_type: row.size_type,
                is_available: row.status === 'AVAILABLE',
                door_status: row.status === 'OCCUPIED' ? 'LOCKED' : 'UNLOCKED',
                price_per_hour: parseFloat(row.price_h || 0),
                updated_at: new Date()
            };
        });

        const defaultStation = {
            _id: defaultStationId,
            location_name: "Stasiun Pusat SewaLokerBox",
            location_geom: {
                type: 'Point',
                coordinates: [106.8456, -6.2088] // Jakarta Pusat coordinates
            },
            connectivity_status: 'ONLINE',
            last_heartbeat: new Date(),
            created_at: new Date(),
            boxes: embeddedBoxes
        };

        await mongoDb.collection('locker_stations').insertOne(defaultStation);
        console.log('✓ default station with embedded boxes populated in locker_stations.');

        // 3. MIGRATE ORDERS (PAYMENT DETAILS)
        console.log('3. Fetching orders (payments) from PostgreSQL...');
        const ordersResult = await pgPool.query('SELECT * FROM "Order"');
        console.log(`Fetched ${ordersResult.rows.length} orders.`);

        await mongoDb.collection('orders').deleteMany({});
        const mongoOrders = ordersResult.rows.map(order => ({
            _id: new ObjectId(),
            legacy_id: order.id,
            order_id: order.order_id,
            user_id: userMap.get(order.user_id) || null,
            locker_size: order.locker_size,
            duration: parseInt(order.duration || 1),
            gross_amount: parseFloat(order.gross_amount || 0),
            payment_status: order.payment_status,
            transaction_id: order.transaction_id || null,
            customer_name: order.customer_name || null,
            customer_email: order.customer_email || null,
            customer_phone: order.customer_phone || null,
            payment_date: order.payment_date ? new Date(order.payment_date) : null,
            created_at: new Date(order.created_at),
            updated_at: new Date(order.updated_at)
        }));

        if (mongoOrders.length > 0) {
            await mongoDb.collection('orders').insertMany(mongoOrders);
            console.log('✓ Orders collection populated.');
        }

        const orderMap = new Map(); // Midtrans order_id -> Order row
        ordersResult.rows.forEach(order => {
            orderMap.set(order.order_id, order);
        });

        // 4. MIGRATE USAGE TRANSACTIONS
        console.log('4. Fetching usage transactions from PostgreSQL...');
        const usageResult = await pgPool.query('SELECT * FROM "UsageTransaction"');
        console.log(`Fetched ${usageResult.rows.length} usage transactions.`);

        const mongoTransactions = usageResult.rows.map(row => {
            const mongoUserId = userMap.get(row.user_id) || null;
            const mongoBoxId = lockerMap.get(row.locker_id) || null;

            // Attempt to match payment details from Order table
            const matchingOrders = ordersResult.rows.filter(o => o.user_id === row.user_id);
            const embeddedPayments = matchingOrders.map(o => ({
                payment_id: new ObjectId(),
                payment_method: 'QRIS', // Default payment gateway method
                payment_status: o.payment_status,
                amount: parseFloat(o.gross_amount || 0),
                gateway_ref: o.transaction_id || null,
                paid_at: o.payment_date ? new Date(o.payment_date) : null
            }));

            return {
                _id: new ObjectId(),
                legacy_usage_id: row.id,
                category: row.category, // COURIER_DROP or USER_DEPOSIT
                box_reference: {
                    station_id: defaultStationId,
                    box_id: mongoBoxId
                },
                parties: {
                    owner_id: mongoUserId,
                    sender_phone: row.sender_phone || null,
                    courier_name: row.courier_name || null,
                    resi_number: row.resi_number || null,
                    recipient_phone: row.recipient_phone
                },
                pickup_code: row.pickup_code,
                status: row.status, // ACTIVE, COMPLETED, WAITING_FOR_PICKUP
                fees: {
                    base_fee: parseFloat(row.base_fee || 0),
                    extension_fee: parseFloat(row.extension_fee || 0),
                    total_fee: parseFloat(row.base_fee || 0) + parseFloat(row.extension_fee || 0)
                },
                timestamps: {
                    created_at: new Date(row.started_at),
                    started_at: new Date(row.started_at),
                    ended_at: row.ended_at ? new Date(row.ended_at) : null
                },
                payments: embeddedPayments,
                activity_logs: [
                    {
                        log_id: new ObjectId(),
                        actor_id: mongoUserId,
                        event_name: 'TRANSACTION_CREATED',
                        description: `Usage transaction created for box legacy_id ${row.locker_id}`,
                        logged_at: new Date(row.started_at)
                    }
                ]
            };
        });

        if (mongoTransactions.length > 0) {
            await mongoDb.collection('transactions').insertMany(mongoTransactions);
            console.log('✓ Transactions collection populated.');
        }

        // 5. MIGRATE TOPUP TRANSACTIONS
        console.log('5. Fetching topup transactions from PostgreSQL...');
        const topupsResult = await pgPool.query('SELECT * FROM "TopUpTransaction"');
        console.log(`Fetched ${topupsResult.rows.length} topup transactions.`);

        const mongoTopups = topupsResult.rows.map(row => {
            const mongoUserId = userMap.get(row.user_id) || null;
            return {
                _id: new ObjectId(),
                legacy_id: row.id,
                user_id: mongoUserId,
                amount: parseFloat(row.amount || 0),
                payment_status: row.payment_status,
                created_at: new Date(row.createdAt || Date.now())
            };
        });

        if (mongoTopups.length > 0) {
            await mongoDb.collection('topup_transactions').insertMany(mongoTopups);
            console.log('✓ TopUp transactions collection populated.');
        }

        // 6. CREATE INDEXES FOR OPTIMAL PERFORMANCE
        console.log('6. Creating indexes in MongoDB...');
        await mongoDb.collection('users').createIndex({ email: 1 }, { unique: true, sparse: true });
        await mongoDb.collection('users').createIndex({ phone_number: 1 }, { unique: true, sparse: true });
        await mongoDb.collection('locker_stations').createIndex({ location_geom: '2dsphere' });
        await mongoDb.collection('locker_stations').createIndex({ "boxes.legacy_locker_id": 1 });
        await mongoDb.collection('transactions').createIndex({ pickup_code: 1 }, { unique: true });
        await mongoDb.collection('transactions').createIndex({ "parties.owner_id": 1 });
        await mongoDb.collection('orders').createIndex({ order_id: 1 }, { unique: true });
        await mongoDb.collection('orders').createIndex({ user_id: 1 });
        
        console.log('✓ Indexes successfully created.');
        console.log('🎉 Database migration completed successfully!');

    } catch (err) {
        console.error('✗ Migration failed:', err);
    } finally {
        await pgPool.end();
        await mongoClient.close();
        console.log('Database connections closed.');
    }
}

runMigration();
