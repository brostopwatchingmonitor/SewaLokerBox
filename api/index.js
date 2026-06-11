require('dotenv').config();
const express = require('express');
const midtransClient = require('midtrans-client');
const cors = require('cors');
const { connectToDatabase } = require('../utils/db');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
const requestLogger = require('../middleware/request-logger');
const errorHandler = require('../middleware/error-handler');
const { sanitizeForLogging } = require('../utils/sanitizer');
const { logValidationError } = require('../middleware/validation-error-logger');
const { logIotError, recordIotSuccess } = require('../middleware/iot-error-logger');

const app = express();

const JWT_SECRET = process.env.JWT_SECRET || 'sewaloker-secret-key-2024';

// =============================================
// DATABASE SETUP (Using MongoDB with caching)
// =============================================

// Test connection on startup
connectToDatabase()
    .then(() => {
        console.log('Database: ✓ Connected (MongoDB)');
        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-api',
            message: 'Database connected successfully'
        });
    })
    .catch(err => {
        console.log('Database: ✗ Failed -', err.message);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'Database connection failed',
            error: {
                type: err.constructor.name,
                message: err.message,
                stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
            },
            tags: ['database', 'connection'],
            severity: 'P1'
        });
    });

// =============================================
// MIDTRANS CONFIGURATION
// =============================================
const MIDTRANS_IS_PRODUCTION = false;
const MIDTRANS_SERVER_KEY = process.env.MIDTRANS_SERVER_KEY;
const MIDTRANS_CLIENT_KEY = process.env.MIDTRANS_CLIENT_KEY;

console.log('===========================================');
console.log('MIDTRANS CONFIGURATION');
console.log('===========================================');
console.log('Mode:', MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX');
console.log('Server Key:', MIDTRANS_SERVER_KEY ? '✓ Loaded' : '✗ MISSING');
console.log('Client Key:', MIDTRANS_CLIENT_KEY ? '✓ Loaded' : '✗ MISSING');
console.log('===========================================');

// Initialize Midtrans Snap
const snap = new midtransClient.Snap({
    isProduction: MIDTRANS_IS_PRODUCTION,
    serverKey: MIDTRANS_SERVER_KEY,
});

// =============================================
// CORS SETUP
// =============================================
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// =============================================
// MIDDLEWARE
// =============================================
app.use(requestLogger); // Request logging middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// =============================================
// HELPER FUNCTIONS
// =============================================
async function createMidtransToken(orderId, grossAmount, itemDetails, customerDetails = {}) {
    try {
        const parameter = {
            transaction_details: {
                order_id: orderId,
                gross_amount: grossAmount
            },
            item_details: itemDetails,
            customer_details: {
                first_name: customerDetails.firstName || 'Customer',
                last_name: customerDetails.lastName || '',
                email: customerDetails.email || 'customer@example.com',
                phone: customerDetails.phone || '081234567890'
            },
            credit_card: {
                secure: true
            },
            callbacks: {
                finish: 'http://localhost:3000?status=success',
                error: 'http://localhost:3000?status=error',
                close: 'http://localhost:3000?status=close'
            }
        };

        const transaction = await snap.createTransaction(parameter);

        return {
            success: true,
            token: transaction.token,
            redirect_url: transaction.redirect_url
        };

    } catch (error) {
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'Midtrans Token Creation Error',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                orderId,
                grossAmount
            },
            tags: ['midtrans', 'token-creation'],
            severity: 'P2'
        });

        return {
            success: false,
            error: error.message || 'Failed to create transaction token'
        };
    }
}

// =============================================
// DATABASE HELPER FUNCTIONS - ALL TABLES
// =============================================
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// =============================================
// AUTH HELPER FUNCTIONS
// =============================================
async function hashPassword(password) {
    return bcrypt.hash(password, 10);
}

async function comparePassword(password, hash) {
    return bcrypt.compare(password, hash);
}

function generateToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, phone: user.phone_number },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (err) {
        return null;
    }
}

// Middleware for auth verification
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, error: 'Token required' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(403).json({ success: false, error: 'Invalid token' });
    }

    req.user = decoded;
    next();
}

// --- MongoDB Mapping Helpers ---
function mapUser(user) {
    if (!user) return null;
    return {
        id: user._id.toString(),
        nfc_uid: user.nfc_uid || null,
        full_name: user.full_name,
        email: user.email || null,
        phone_number: user.phone_number || null,
        password: user.security?.password || null,
        balance: user.wallet_balance || 0,
        createdAt: user.created_at
    };
}

function mapLocker(box) {
    if (!box) return null;
    return {
        id: box.legacy_locker_id || box.box_id.toString(),
        size_type: box.size_type,
        price_h: box.price_per_hour || 0,
        status: box.is_available ? 'AVAILABLE' : 'OCCUPIED'
    };
}

function mapOrder(order) {
    if (!order) return null;
    return {
        id: order._id.toString(),
        order_id: order.order_id,
        user_id: order.user_id ? order.user_id.toString() : null,
        locker_size: order.locker_size,
        duration: order.duration,
        gross_amount: order.gross_amount,
        payment_status: order.payment_status,
        transaction_id: order.transaction_id || null,
        customer_name: order.customer_name || null,
        customer_email: order.customer_email || null,
        customer_phone: order.customer_phone || null,
        payment_date: order.payment_date || null,
        created_at: order.created_at,
        updated_at: order.updated_at
    };
}

function mapTransaction(txn) {
    if (!txn) return null;
    return {
        id: txn._id.toString(),
        category: txn.category,
        user_id: txn.parties.owner_id ? txn.parties.owner_id.toString() : null,
        sender_phone: txn.parties.sender_phone || null,
        courier_name: txn.parties.courier_name || null,
        resi_number: txn.parties.resi_number || null,
        recipient_phone: txn.parties.recipient_phone,
        pickup_code: txn.pickup_code,
        locker_id: txn.box_reference.legacy_locker_id || null,
        started_at: txn.timestamps.started_at,
        duration_plan: txn.duration_plan || null,
        ended_at: txn.timestamps.ended_at || null,
        base_fee: txn.fees.base_fee,
        extension_fee: txn.fees.extension_fee || 0,
        status: txn.status
    };
}

// Helper to support both legacy UUID string keys and BSON ObjectIds
function getUserQuery(id) {
    if (!id) return { _id: null };
    if (ObjectId.isValid(id) && id.toString().length === 24) {
        return { _id: new ObjectId(id) };
    }
    return { legacy_id: id };
}

// Helper to resolve any format of user ID to MongoDB BSON ObjectId
async function resolveMongoUserId(userId) {
    if (!userId) return null;
    const { db } = await connectToDatabase();
    const query = getUserQuery(userId);
    const user = await db.collection('users').findOne(query);
    return user ? user._id : null;
}

// --- User Functions ---
async function findUserByEmail(email) {
    const { db } = await connectToDatabase();
    const user = await db.collection('users').findOne({ email });
    return mapUser(user);
}

async function findUserByPhone(phone) {
    const { db } = await connectToDatabase();
    const user = await db.collection('users').findOne({ phone_number: phone });
    return mapUser(user);
}

async function findOrCreateUser(customerName, customerEmail, customerPhone) {
    const { db } = await connectToDatabase();
    const query = [];
    if (customerEmail) query.push({ email: customerEmail });
    if (customerPhone) query.push({ phone_number: customerPhone });
    
    let user = null;
    if (query.length > 0) {
        user = await db.collection('users').findOne({ $or: query });
    }
    
    if (user) {
        console.log('✓ Existing user found:', user._id.toString());
        return mapUser(user);
    }

    // Create new user
    const mongoId = new ObjectId();
    const newUser = {
        _id: mongoId,
        full_name: customerName || 'Pelanggan',
        email: customerEmail || undefined,
        phone_number: customerPhone || undefined,
        security: { password: '' },
        wallet_balance: 0,
        created_at: new Date(),
        updated_at: new Date()
    };
    await db.collection('users').insertOne(newUser);
    console.log('✓ New user created:', mongoId.toString());
    return mapUser(newUser);
}

async function updateUserBalance(userId, newBalance) {
    const { db } = await connectToDatabase();
    const query = getUserQuery(userId);
    await db.collection('users').updateOne(
        query,
        { $set: { wallet_balance: parseFloat(newBalance), updated_at: new Date() } }
    );
    const user = await db.collection('users').findOne(query);
    return mapUser(user);
}

// --- Locker Functions ---
async function findAvailableLocker(sizeType) {
    const { db } = await connectToDatabase();
    let sizeMapping = sizeType === 'Small' ? ['S', 'M'] : ['L'];
    
    const station = await db.collection('locker_stations').findOne({
        connectivity_status: 'ONLINE',
        boxes: {
            $elemMatch: {
                size_type: { $in: sizeMapping },
                is_available: true
            }
        }
    });

    if (station) {
        const box = station.boxes.find(b => sizeMapping.includes(b.size_type) && b.is_available);
        console.log('✓ Available locker found:', box.legacy_locker_id);
        return mapLocker(box);
    }

    // Fallback: get first box matching size mapping
    const fallbackStation = await db.collection('locker_stations').findOne({
        boxes: { $elemMatch: { size_type: { $in: sizeMapping } } }
    });
    if (fallbackStation) {
        const box = fallbackStation.boxes.find(b => sizeMapping.includes(b.size_type));
        return mapLocker(box);
    }
    return null;
}

async function updateLockerStatus(lockerId, status) {
    const { db } = await connectToDatabase();
    const isAvailable = status === 'AVAILABLE';
    
    await db.collection('locker_stations').updateOne(
        { "boxes.legacy_locker_id": parseInt(lockerId) },
        { 
            $set: { 
                "boxes.$.is_available": isAvailable,
                "boxes.$.door_status": status === 'OCCUPIED' ? 'LOCKED' : 'UNLOCKED',
                "boxes.$.updated_at": new Date()
            } 
        }
    );
    
    const station = await db.collection('locker_stations').findOne({ "boxes.legacy_locker_id": parseInt(lockerId) });
    const box = station?.boxes.find(b => b.legacy_locker_id === parseInt(lockerId));
    return mapLocker(box);
}

// =============================================
// ARDUINO/IOT HELPER FUNCTIONS
// =============================================
const https = require('https');

// Store registered Arduino devices
let arduinoDevices = new Map();

// Send command to Arduino via HTTP
async function sendCommandToArduino(ip, port, command, data = {}) {
    const lockerId = data.lockerId || data.locker_id || 'unknown';
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(data);
        const options = {
            hostname: ip,
            port: port || 80,
            path: `/${command}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 5000
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    recordIotSuccess(lockerId);
                    resolve(json);
                } catch (e) {
                    recordIotSuccess(lockerId);
                    resolve({ success: true, message: body });
                }
            });
        });

        req.on('error', (err) => {
            console.log('Arduino communication error:', err.message);
            logIotError(err, lockerId, command);
            // Fallback: resolve as success since Arduino might be unreachable but will process later
            resolve({ success: false, error: err.message, offline: true });
        });

        req.on('timeout', () => {
            req.destroy();
            logIotError(new Error('Timeout'), lockerId, command);
            resolve({ success: false, error: 'Timeout', offline: true });
        });

        req.write(postData);
        req.end();
    });
}

// Get Arduino device by locker ID
function getArduinoByLocker(lockerId) {
    for (const [key, device] of arduinoDevices) {
        if (device.lockerId === lockerId) {
            return device;
        }
    }
    return null;
}

// --- Order Functions ---
async function createOrder(orderData) {
    const { db } = await connectToDatabase();
    const { orderId, userId, lockerSize, duration, grossAmount, customerName, customerEmail, customerPhone } = orderData;
    const mongoOrderId = new ObjectId();
    const mongoUserId = await resolveMongoUserId(userId);

    const orderDoc = {
        _id: mongoOrderId,
        order_id: orderId,
        user_id: mongoUserId,
        locker_size: lockerSize,
        duration: parseInt(duration || 1),
        gross_amount: parseFloat(grossAmount || 0),
        payment_status: 'PENDING',
        customer_name: customerName || null,
        customer_email: customerEmail || null,
        customer_phone: customerPhone || null,
        created_at: new Date(),
        updated_at: new Date()
    };

    await db.collection('orders').insertOne(orderDoc);
    return {
        id: mongoOrderId.toString(),
        order_id: orderId,
        payment_status: 'PENDING'
    };
}

async function updateOrderWithUser(orderId, userId) {
    const { db } = await connectToDatabase();
    const mongoUserId = await resolveMongoUserId(userId);
    await db.collection('orders').updateOne(
        { order_id: orderId },
        { $set: { user_id: mongoUserId, updated_at: new Date() } }
    );
    const order = await db.collection('orders').findOne({ order_id: orderId });
    return mapOrder(order);
}

async function updateOrderStatus(orderId, paymentStatus, transactionId = null, lockerId = null) {
    const { db } = await connectToDatabase();
    const updateFields = {
        payment_status: paymentStatus,
        updated_at: new Date()
    };
    if (transactionId) {
        updateFields.transaction_id = transactionId;
    }
    if (paymentStatus === 'PAID') {
        updateFields.payment_date = new Date();
    }
    await db.collection('orders').updateOne(
        { order_id: orderId },
        { $set: updateFields }
    );
    const order = await db.collection('orders').findOne({ order_id: orderId });
    return mapOrder(order);
}

async function getOrderById(orderId) {
    const { db } = await connectToDatabase();
    const order = await db.collection('orders').findOne({ order_id: orderId });
    return mapOrder(order);
}

async function getAllOrders(limit = 50) {
    const { db } = await connectToDatabase();
    const orders = await db.collection('orders')
        .find()
        .sort({ created_at: -1 })
        .limit(limit)
        .toArray();
    return orders.map(mapOrder);
}

// --- UsageTransaction Functions ---
async function createUsageTransaction(usageData) {
    const { db } = await connectToDatabase();
    const { userId, lockerId, recipientPhone, pickupCode, baseFee, durationPlan, orderId } = usageData;
    const mongoTxId = new ObjectId();

    const order = orderId ? await getOrderById(orderId) : null;
    const mongoUserId = await resolveMongoUserId(userId);
    
    // Find the box_id for this lockerId
    const station = await db.collection('locker_stations').findOne({ "boxes.legacy_locker_id": parseInt(lockerId) });
    const box = station?.boxes.find(b => b.legacy_locker_id === parseInt(lockerId));

    const txnDoc = {
        _id: mongoTxId,
        category: userId ? 'USER_DEPOSIT' : 'COURIER_DROP',
        box_reference: {
            station_id: station ? station._id : null,
            box_id: box ? box.box_id : null,
            legacy_locker_id: parseInt(lockerId)
        },
        parties: {
            owner_id: mongoUserId,
            sender_phone: usageData.senderPhone || null,
            courier_name: usageData.courierName || null,
            resi_number: usageData.resiNumber || null,
            recipient_phone: recipientPhone || order?.customer_phone
        },
        pickup_code: pickupCode,
        status: 'ACTIVE',
        fees: {
            base_fee: parseFloat(baseFee || order?.gross_amount || 0),
            extension_fee: 0,
            total_fee: parseFloat(baseFee || order?.gross_amount || 0)
        },
        duration_plan: parseInt(durationPlan || order?.duration || 1),
        timestamps: {
            created_at: new Date(),
            started_at: new Date(),
            ended_at: null
        },
        payments: order ? [{
            payment_id: new ObjectId(),
            payment_method: 'QRIS',
            payment_status: order.payment_status,
            amount: parseFloat(order.gross_amount),
            gateway_ref: order.transaction_id || null,
            paid_at: new Date()
        }] : [],
        activity_logs: [{
            log_id: new ObjectId(),
            actor_id: mongoUserId,
            event_name: 'TRANSACTION_CREATED',
            description: `Usage transaction created for locker ${lockerId}`,
            logged_at: new Date()
        }]
    };

    await db.collection('transactions').insertOne(txnDoc);
    console.log('✓ UsageTransaction created in MongoDB:', txnDoc._id);
    
    return {
        id: mongoTxId.toString(),
        category: txnDoc.category,
        user_id: mongoUserId ? mongoUserId.toString() : null,
        recipient_phone: txnDoc.parties.recipient_phone,
        pickup_code: pickupCode,
        locker_id: parseInt(lockerId),
        started_at: txnDoc.timestamps.started_at,
        duration_plan: txnDoc.duration_plan,
        base_fee: txnDoc.fees.base_fee,
        extension_fee: 0,
        status: 'ACTIVE'
    };
}

async function getUsageTransactionByPickupCode(pickupCode) {
    const { db } = await connectToDatabase();
    const txn = await db.collection('transactions').findOne({ pickup_code: pickupCode });
    if (!txn) return null;

    // Join with locker details
    const legacyLockerId = txn.box_reference.legacy_locker_id;
    const station = await db.collection('locker_stations').findOne({ "boxes.legacy_locker_id": legacyLockerId });
    const box = station?.boxes.find(b => b.legacy_locker_id === legacyLockerId);

    return {
        id: txn._id.toString(),
        category: txn.category,
        user_id: txn.parties.owner_id ? txn.parties.owner_id.toString() : null,
        sender_phone: txn.parties.sender_phone || null,
        courier_name: txn.parties.courier_name || null,
        resi_number: txn.parties.resi_number || null,
        recipient_phone: txn.parties.recipient_phone,
        pickup_code: txn.pickup_code,
        locker_id: legacyLockerId,
        started_at: txn.timestamps.started_at,
        duration_plan: txn.duration_plan || null,
        ended_at: txn.timestamps.ended_at || null,
        base_fee: txn.fees.base_fee,
        extension_fee: txn.fees.extension_fee || 0,
        status: txn.status,
        size_type: box ? box.size_type : null,
        locker_status: box ? (box.is_available ? 'AVAILABLE' : 'OCCUPIED') : null
    };
}

async function completeUsageTransaction(pickupCode) {
    const { db } = await connectToDatabase();
    await db.collection('transactions').updateOne(
        { pickup_code: pickupCode },
        { 
            $set: { 
                status: 'COMPLETED',
                "timestamps.ended_at": new Date() 
            },
            $push: {
                activity_logs: {
                    log_id: new ObjectId(),
                    event_name: 'BOX_PICKED_UP',
                    description: 'Barang diambil, sewa selesai.',
                    logged_at: new Date()
                }
            }
        }
    );
    const txn = await db.collection('transactions').findOne({ pickup_code: pickupCode });
    return mapTransaction(txn);
}

// --- TopUpTransaction Functions ---
async function createTopUpTransaction(topUpData) {
    const { db } = await connectToDatabase();
    const { userId, amount, paymentStatus = 'PENDING' } = topUpData;
    const mongoTxId = new ObjectId();
    const mongoUserId = await resolveMongoUserId(userId);

    const doc = {
        _id: mongoTxId,
        user_id: mongoUserId,
        amount: parseFloat(amount),
        payment_status: paymentStatus,
        created_at: new Date()
    };

    await db.collection('topup_transactions').insertOne(doc);
    return {
        id: mongoTxId.toString(),
        user_id: mongoUserId ? mongoUserId.toString() : null,
        amount: parseFloat(amount),
        payment_status: paymentStatus,
        createdAt: doc.created_at
    };
}

// =============================================
// API ENDPOINTS
// =============================================

// =============================================
// AUTH ENDPOINTS
// =============================================

// Register new user
app.post('/api/auth/register', async (req, res) => {
    try {
        const { fullName, email, phoneNumber, password } = req.body;

        if (!fullName || !email || !phoneNumber || !password) {
            const missingField = !fullName ? 'fullName' : (!email ? 'email' : (!phoneNumber ? 'phoneNumber' : 'password'));
            logValidationError(new Error('Semua field wajib diisi'), req, {
                message: 'Semua field wajib diisi',
                field: missingField,
                value: req.body[missingField],
                rule: 'required',
                severity: 'low'
            });
            return res.status(400).json({
                success: false,
                error: 'Semua field wajib diisi'
            });
        }

        // Check if user already exists
        const existingUser = await findUserByEmail(email);
        if (existingUser) {
            logValidationError(new Error('Email sudah terdaftar'), req, {
                message: 'Email sudah terdaftar',
                field: 'email',
                value: email,
                rule: 'unique',
                severity: 'low'
            });
            return res.status(400).json({
                success: false,
                error: 'Email sudah terdaftar'
            });
        }

        // Check if phone already exists
        const existingPhone = await findUserByPhone(phoneNumber);
        if (existingPhone) {
            logValidationError(new Error('Nomor telepon sudah terdaftar'), req, {
                message: 'Nomor telepon sudah terdaftar',
                field: 'phoneNumber',
                value: phoneNumber,
                rule: 'unique',
                severity: 'low'
            });
            return res.status(400).json({
                success: false,
                error: 'Nomor telepon sudah terdaftar'
            });
        }

        // Hash password
        const hashedPassword = await hashPassword(password);

        // Create user
        const { db } = await connectToDatabase();
        const mongoUserId = new ObjectId();
        const newUser = {
            _id: mongoUserId,
            full_name: fullName,
            email: email,
            phone_number: phoneNumber,
            security: {
                password: hashedPassword
            },
            wallet_balance: 0,
            created_at: new Date(),
            updated_at: new Date()
        };
        await db.collection('users').insertOne(newUser);

        const user = {
            id: mongoUserId.toString(),
            full_name: fullName,
            email: email,
            phone_number: phoneNumber,
            createdAt: newUser.created_at
        };
        const token = generateToken(user);

        console.log('✓ New user registered:', user.id);
        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-api',
            message: 'New user registered',
            context: {
                userId: user.id,
                email: user.email
            },
            tags: ['auth', 'register'],
            severity: 'P3'
        });

        res.json({
            success: true,
            message: 'Registrasi berhasil',
            token: token,
            user: {
                id: user.id,
                fullName: user.full_name,
                email: user.email,
                phoneNumber: user.phone_number
            }
        });

    } catch (error) {
        console.error('Register Error:', error);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'Register Error',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                body: sanitizeForLogging(req.body)
            },
            tags: ['auth', 'register', 'error'],
            severity: 'P2'
        });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            const missingField = !email ? 'email' : 'password';
            logValidationError(new Error('Email dan password wajib diisi'), req, {
                message: 'Email dan password wajib diisi',
                field: missingField,
                value: req.body[missingField],
                rule: 'required',
                severity: 'low'
            });
            return res.status(400).json({
                success: false,
                error: 'Email dan password wajib diisi'
            });
        }

        // Find user by email
        const user = await findUserByEmail(email);
        if (!user || !user.password) {
            return res.status(401).json({
                success: false,
                error: 'Email atau password salah'
            });
        }

        // Check password
        const isValid = await comparePassword(password, user.password);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                error: 'Email atau password salah'
            });
        }

        const token = generateToken(user);

        console.log('✓ User logged in:', user.id);
        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-api',
            message: 'User logged in',
            context: {
                userId: user.id,
                email: user.email
            },
            tags: ['auth', 'login'],
            severity: 'P3'
        });

        res.json({
            success: true,
            message: 'Login berhasil',
            token: token,
            user: {
                id: user.id,
                fullName: user.full_name,
                email: user.email,
                phoneNumber: user.phone_number,
                balance: user.balance,
                nfcUid: user.nfc_uid
            }
        });

    } catch (error) {
        console.error('Login Error:', error);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'Login Error',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                body: sanitizeForLogging(req.body)
            },
            tags: ['auth', 'login', 'error'],
            severity: 'P2'
        });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get current user profile
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const { db } = await connectToDatabase();
        const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });

        if (!userDoc) {
            return res.status(404).json({
                success: false,
                error: 'User tidak ditemukan'
            });
        }

        const user = mapUser(userDoc);

        res.json({
            success: true,
            user: {
                id: user.id,
                fullName: user.full_name,
                email: user.email,
                phoneNumber: user.phone_number,
                balance: user.balance,
                nfcUid: user.nfc_uid,
                createdAt: user.createdAt
            }
        });

    } catch (error) {
        console.error('Get Profile Error:', error);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'Get Profile Error',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                userId: req.user?.id
            },
            tags: ['auth', 'profile', 'error'],
            severity: 'P2'
        });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Update profile
app.put('/api/auth/profile', authenticateToken, async (req, res) => {
    try {
        const { fullName, phoneNumber } = req.body;
        const { db } = await connectToDatabase();

        const updateFields = {};
        if (fullName !== undefined) updateFields.full_name = fullName;
        if (phoneNumber !== undefined) updateFields.phone_number = phoneNumber;
        updateFields.updated_at = new Date();

        await db.collection('users').updateOne(
            { _id: new ObjectId(req.user.id) },
            { $set: updateFields }
        );

        const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });
        if (!userDoc) {
            return res.status(404).json({
                success: false,
                error: 'User tidak ditemukan'
            });
        }

        const user = mapUser(userDoc);

        res.json({
            success: true,
            message: 'Profile updated',
            user: {
                id: user.id,
                fullName: user.full_name,
                email: user.email,
                phoneNumber: user.phone_number
            }
        });

    } catch (error) {
        console.error('Update Profile Error:', error);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'Update Profile Error',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                userId: req.user?.id,
                body: sanitizeForLogging(req.body)
            },
            tags: ['auth', 'profile', 'error'],
            severity: 'P2'
        });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Change password
app.put('/api/auth/password', authenticateToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                error: 'Password lama dan baru wajib diisi'
            });
        }

        const { db } = await connectToDatabase();
        const userDoc = await db.collection('users').findOne({ _id: new ObjectId(req.user.id) });

        if (!userDoc || !userDoc.security?.password) {
            return res.status(400).json({
                success: false,
                error: 'Akun belum memiliki password'
            });
        }

        // Verify current password
        const isValid = await comparePassword(currentPassword, userDoc.security.password);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                error: 'Password lama salah'
            });
        }

        // Update password
        const hashedPassword = await hashPassword(newPassword);
        await db.collection('users').updateOne(
            { _id: new ObjectId(req.user.id) },
            { $set: { "security.password": hashedPassword, updated_at: new Date() } }
        );

        res.json({
            success: true,
            message: 'Password berhasil diubah'
        });

    } catch (error) {
        console.error('Change Password Error:', error);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'Change Password Error',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                userId: req.user?.id,
                body: sanitizeForLogging(req.body)
            },
            tags: ['auth', 'password', 'error'],
            severity: 'P2'
        });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 1. Get Client Key
app.get('/api/config', (req, res) => {
    res.json({
        clientKey: MIDTRANS_CLIENT_KEY,
        isProduction: MIDTRANS_IS_PRODUCTION
    });
});

// 2. Create Order & Get Snap Token
app.post('/api/create-order', async (req, res) => {
    try {
        const {
            lockerSize,
            duration,
            price,
            customerName,
            customerEmail,
            customerPhone,
            userId
        } = req.body;

        // Validasi input
        if (!lockerSize || !price) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: lockerSize, price'
            });
        }

        // Generate order ID
        const orderId = `LOKER-${lockerSize.toUpperCase()}-${Date.now()}`;
        const grossAmount = parseInt(price) * (parseInt(duration) || 1);

        console.log('\n=== CREATING FULL TRANSACTION ===');
        console.log('Order ID:', orderId);
        console.log('Gross Amount:', grossAmount);
        console.log('User ID:', userId || 'Anonymous');
        console.log('========================\n');

        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-api',
            message: 'Creating order',
            context: {
                orderId,
                lockerSize,
                duration,
                price,
                grossAmount,
                customerName,
                customerEmail,
                customerPhone,
                userId
            },
            tags: ['order', 'create'],
            severity: 'P3'
        });

        let user;
        const { db } = await connectToDatabase();

        // 1. If authenticated user (via token), use that user
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            const decoded = verifyToken(token);
            if (decoded) {
                const userDoc = await db.collection('users').findOne({ _id: new ObjectId(decoded.id) });
                if (userDoc) {
                    user = mapUser(userDoc);
                    console.log('✓ Authenticated user:', user.id);
                }
            }
        }

        // 2. If no authenticated user but userId provided, find by ID
        if (!user && userId) {
            const userDoc = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            if (userDoc) {
                user = mapUser(userDoc);
                console.log('✓ User found by ID:', user.id);
            }
        }

        // 3. Otherwise, find or create by email/phone (guest checkout)
        if (!user) {
            user = await findOrCreateUser(customerName, customerEmail, customerPhone);
        }

        // 2. Find available locker
        const locker = await findAvailableLocker(lockerSize);
        if (!locker) {
            return res.status(400).json({
                success: false,
                error: 'No locker available for this size'
            });
        }

        // 3. Create order with user_id and locker info
        const order = await createOrder({
            orderId,
            userId: user.id,
            lockerSize,
            duration: parseInt(duration) || 1,
            grossAmount,
            customerName: customerName || user.full_name,
            customerEmail: user.email,
            customerPhone: user.phone_number
        });

        console.log('✓ Order created in database:', order.order_id);
        console.log('✓ User:', user.id);
        console.log('✓ Locker:', locker.id);

        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-api',
            message: 'Order created in database',
            context: {
                orderId: order.order_id,
                userId: user.id,
                lockerId: locker.id
            },
            tags: ['order', 'database'],
            severity: 'P3'
        });

        // Item details for Midtrans
        const itemDetails = [{
            id: `LOKER-${lockerSize.toUpperCase()}`,
            price: parseInt(price),
            quantity: parseInt(duration) || 1,
            name: `Sewa Loker ${lockerSize} (${duration || 1} jam)`
        }];

        // Customer details
        const customerDetails = {
            firstName: customerName || user.full_name,
            email: user.email,
            phone: user.phone_number
        };

        // Create Midtrans token
        const result = await createMidtransToken(
            orderId,
            grossAmount,
            itemDetails,
            customerDetails
        );

        if (result.success) {
            res.json({
                success: true,
                token: result.token,
                redirect_url: result.redirect_url,
                orderId: orderId,
                databaseId: order.id,
                userId: user.id,
                lockerId: locker.id
            });
        } else {
            // Hapus order jika gagal membuat token
            await db.collection('orders').deleteOne({ _id: new ObjectId(order.id) });
            res.status(500).json({
                success: false,
                error: result.error
            });
        }

    } catch (error) {
        console.error('API Error:', error);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'API Error in create-order',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                body: sanitizeForLogging(req.body)
            },
            tags: ['api', 'create-order', 'error'],
            severity: 'P2'
        });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 3. Webhook Handler (PENTING! Untuk update status payment)
app.post('/api/webhook', async (req, res) => {
    try {
        const notification = req.body;
        console.log('Webhook received:', JSON.stringify(notification, null, 2));

        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-api',
            message: 'Webhook received',
            context: {
                notification: sanitizeForLogging(notification)
            },
            tags: ['webhook', 'midtrans'],
            severity: 'P3'
        });

        // Verify notification with Midtrans
        const statusResponse = await snap.transaction.notification(notification);

        const orderId = statusResponse.order_id;
        const transactionStatus = statusResponse.transaction_status;
        const transactionId = statusResponse.transaction_id;

        console.log(`Transaction Status: ${orderId} - ${transactionStatus}`);

        // Determine payment status
        let paymentStatus;
        switch (transactionStatus) {
            case 'settlement':
            case 'capture':
                paymentStatus = 'PAID';
                break;
            case 'pending':
                paymentStatus = 'PENDING';
                break;
            case 'deny':
            case 'cancel':
            case 'expire':
                paymentStatus = 'FAILED';
                break;
            default:
                paymentStatus = 'PENDING';
        }

        // Update order in database
        const updatedOrder = await updateOrderStatus(orderId, paymentStatus, transactionId);

        if (updatedOrder) {
            console.log('✓ Order updated:', updatedOrder.order_id, '->', updatedOrder.payment_status);

            logger.info({
                timestamp: new Date().toISOString(),
                level: 'INFO',
                service: 'sewalokerbox-api',
                message: 'Order updated via webhook',
                context: {
                    orderId: updatedOrder.order_id,
                    paymentStatus: updatedOrder.payment_status,
                    transactionId
                },
                tags: ['order', 'update', 'webhook'],
                severity: 'P3'
            });

            // If payment is successful, create UsageTransaction
            if (paymentStatus === 'PAID' && updatedOrder.user_id) {
                // Generate pickup code
                const pickupCode = `PICK-${Date.now().toString(36).toUpperCase()}`;

                // Find locker based on locker_size
                const locker = await findAvailableLocker(updatedOrder.locker_size);
                if (locker) {
                    await createUsageTransaction({
                        userId: updatedOrder.user_id,
                        lockerId: locker.id,
                        recipientPhone: updatedOrder.customer_phone,
                        pickupCode: pickupCode,
                        baseFee: updatedOrder.gross_amount,
                        durationPlan: updatedOrder.duration,
                        orderId: orderId
                    });

                    // Update locker status to OCCUPIED
                    await updateLockerStatus(locker.id, 'OCCUPIED');
                }
            }
        } else {
            console.log('⚠ Order not found in database:', orderId);
            logger.warn({
                timestamp: new Date().toISOString(),
                level: 'WARN',
                service: 'sewalokerbox-api',
                message: 'Order not found in database',
                context: {
                    orderId
                },
                tags: ['webhook', 'order', 'not-found'],
                severity: 'P3'
            });
        }

        res.status(200).json({
            success: true,
            orderId: orderId,
            status: transactionStatus,
            databaseUpdated: !!updatedOrder
        });

    } catch (error) {
        console.error("Webhook Error:", error);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'Webhook Error',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                body: sanitizeForLogging(req.body)
            },
            tags: ['webhook', 'error'],
            severity: 'P2'
        });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 4. Get Order Status
app.get('/api/order/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const order = await getOrderById(orderId);

        if (!order) {
            return res.status(404).json({
                success: false,
                error: 'Order not found'
            });
        }

        res.json({
            success: true,
            order: order
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 5. Check Transaction Status (Midtrans)
app.get('/api/transaction/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const status = await snap.transaction.status(orderId);

        res.json({
            success: true,
            orderId: status.order_id,
            transactionStatus: status.transaction_status,
            grossAmount: status.gross_amount
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 6. NFC Tap Endpoint
app.post('/api/tap', async (req, res) => {
    const { nfc_uid } = req.body;
    console.log('NFC Tap received for UID:', nfc_uid);

    try {
        const { db } = await connectToDatabase();
        const userDoc = await db.collection('users').findOne({ nfc_uid: nfc_uid });
        
        let usage = null;
        if (userDoc) {
            const activeTxn = await db.collection('transactions').findOne(
                { "parties.owner_id": userDoc._id, status: 'ACTIVE' },
                { sort: { "timestamps.started_at": -1 } }
            );
            if (activeTxn) {
                usage = {
                    ...mapUser(userDoc),
                    pickup_code: activeTxn.pickup_code,
                    locker_id: activeTxn.box_reference.legacy_locker_id,
                    usage_status: activeTxn.status,
                    usage_id: activeTxn._id.toString()
                };
            }
        }

        if (usage && usage.pickup_code) {
            // Complete the usage transaction
            await completeUsageTransaction(usage.pickup_code);

            // Update locker status back to AVAILABLE
            await updateLockerStatus(usage.locker_id, 'AVAILABLE');

            // Trigger Arduino unlock
            const device = getArduinoByLocker(usage.locker_id);
            let arduinoResult = { success: true, offline: true };
            if (device) {
                arduinoResult = await sendCommandToArduino(device.ip, device.port, 'unlock', {
                    lockerId: usage.locker_id,
                    status: 'UNLOCKED'
                });
                console.log(`✓ Arduino unlock triggered for locker ${usage.locker_id}`);

                logger.info({
                    timestamp: new Date().toISOString(),
                    level: 'INFO',
                    service: 'sewalokerbox-iot',
                    message: `Arduino unlock triggered for locker ${usage.locker_id}`,
                    context: {
                        lockerId: usage.locker_id,
                        ip: device.ip,
                        port: device.port
                    },
                    tags: ['iot', 'arduino', 'unlock'],
                    severity: 'P3'
                });
            }

            res.json({
                success: true,
                status: "UNLOCK_SUCCESS",
                message: "Locker berhasil dibuka",
                pickup_code: usage.pickup_code,
                user_name: userDoc.full_name,
                arduino: arduinoResult
            });
        } else {
            res.json({
                success: true,
                status: "TAP_RECORDED",
                message: "NFC tap recorded - user not recognized",
                nfc_uid: nfc_uid
            });
        }
    } catch (error) {
        console.error('NFC Tap Error:', error);
        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-api',
            message: 'NFC Tap Error',
            error: {
                type: error.constructor.name,
                message: error.message,
                stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
            },
            context: {
                nfc_uid: req.body.nfc_uid
            },
            tags: ['nfc', 'tap', 'error'],
            severity: 'P2'
        });
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 6b. Get Pickup Code by Order ID (for display after payment)
app.get('/api/pickup/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;
        const { db } = await connectToDatabase();

        const order = await db.collection('orders').findOne({ order_id: orderId });
        if (!order) {
            return res.status(404).json({
                success: false,
                error: 'No order found with this orderId'
            });
        }

        const txn = await db.collection('transactions').findOne(
            { "parties.owner_id": order.user_id ? new ObjectId(order.user_id) : null },
            { sort: { "timestamps.started_at": -1 } }
        );

        if (txn) {
            const legacyLockerId = txn.box_reference.legacy_locker_id;
            const station = await db.collection('locker_stations').findOne({ "boxes.legacy_locker_id": legacyLockerId });
            const box = station?.boxes.find(b => b.legacy_locker_id === legacyLockerId);

            res.json({
                success: true,
                pickup_code: txn.pickup_code,
                locker_id: legacyLockerId,
                size_type: box ? box.size_type : null
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'No usage transaction found for this order'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 6c. Get User by NFC UID
app.get('/api/user/nfc/:nfcUid', async (req, res) => {
    try {
        const { nfcUid } = req.params;
        const { db } = await connectToDatabase();

        const userDoc = await db.collection('users').findOne({ nfc_uid: nfcUid });

        if (userDoc) {
            res.json({
                success: true,
                user: mapUser(userDoc)
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'User not found with this NFC UID'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 6d. Register NFC UID to User
app.post('/api/register-nfc', async (req, res) => {
    try {
        const { userId, nfcUid } = req.body;
        const { db } = await connectToDatabase();

        if (!userId || !nfcUid) {
            return res.status(400).json({
                success: false,
                error: 'userId and nfcUid are required'
            });
        }

        await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { $set: { nfc_uid: nfcUid, updated_at: new Date() } }
        );

        const userDoc = await db.collection('users').findOne({ _id: new ObjectId(userId) });

        if (userDoc) {
            res.json({
                success: true,
                message: 'NFC UID registered successfully',
                user: mapUser(userDoc)
            });
        } else {
            res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 7. Get All Lockers
app.get('/api/lockers', async (req, res) => {
    try {
        const { db } = await connectToDatabase();
        const station = await db.collection('locker_stations').findOne({ location_name: "Stasiun Pusat SewaLokerBox" });
        const boxes = station ? station.boxes : [];
        const lockers = boxes.map(mapLocker).sort((a, b) => a.id - b.id);

        res.json({
            success: true,
            count: lockers.length,
            lockers: lockers
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// =============================================
// ARDUINO/IOT ENDPOINTS
// =============================================

// Register Arduino device
app.post('/api/arduino/register', async (req, res) => {
    try {
        const { ip, port, lockerId, hardwareId } = req.body;

        if (!ip || !lockerId) {
            return res.status(400).json({
                success: false,
                error: 'IP dan lockerId wajib diisi'
            });
        }

        const deviceKey = `locker-${lockerId}`;
        arduinoDevices.set(deviceKey, {
            ip,
            port: port || 80,
            lockerId,
            hardwareId: hardwareId || `ARD-${lockerId}-${Date.now()}`,
            registeredAt: new Date(),
            lastHeartbeat: new Date()
        });

        console.log(`✓ Arduino registered for locker ${lockerId}: ${ip}:${port || 80}`);
        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-iot',
            message: `Arduino registered for locker ${lockerId}`,
            context: {
                lockerId,
                ip,
                port: port || 80,
                hardwareId: hardwareId || `ARD-${lockerId}-${Date.now()}`
            },
            tags: ['iot', 'arduino', 'register'],
            severity: 'P3'
        });

        res.json({
            success: true,
            message: 'Arduino device registered',
            device: {
                lockerId,
                ip,
                port: port || 80,
                hardwareId: arduinoDevices.get(deviceKey).hardwareId
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Arduino heartbeat/-status update
app.post('/api/arduino/heartbeat', async (req, res) => {
    try {
        const { lockerId, status, ip, port } = req.body;

        if (!lockerId) {
            return res.status(400).json({
                success: false,
                error: 'lockerId wajib diisi'
            });
        }

        const deviceKey = `locker-${lockerId}`;
        if (arduinoDevices.has(deviceKey)) {
            const device = arduinoDevices.get(deviceKey);
            device.lastHeartbeat = new Date();
            if (ip) device.ip = ip;
            if (port) device.port = port;
        } else {
            // Auto-register if not found
            arduinoDevices.set(deviceKey, {
                ip: ip || 'unknown',
                port: port || 80,
                lockerId,
                registeredAt: new Date(),
                lastHeartbeat: new Date()
            });
        }

        res.json({
            success: true,
            message: 'Heartbeat received'
        });

        logger.debug({
            timestamp: new Date().toISOString(),
            level: 'DEBUG',
            service: 'sewalokerbox-iot',
            message: 'Heartbeat received',
            context: {
                lockerId,
                status,
                ip,
                port
            },
            tags: ['iot', 'arduino', 'heartbeat'],
            severity: 'P4'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });

        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-iot',
            message: 'Heartbeat error',
            error: {
                type: error.constructor.name,
                message: error.message
            },
            context: {
                lockerId: req.body.lockerId,
                ip: req.body.ip,
                port: req.body.port
            },
            tags: ['iot', 'arduino', 'heartbeat', 'error'],
            severity: 'P2'
        });
    }
});

// Lock specific locker
app.post('/api/locker/:lockerId/lock', async (req, res) => {
    try {
        const { lockerId } = req.params;
        const id = parseInt(lockerId);

        if (isNaN(id)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid locker ID'
            });
        }

        // Update database
        const updated = await updateLockerStatus(id, 'OCCUPIED');

        // Send command to Arduino
        const device = getArduinoByLocker(id);
        let arduinoResult = { success: true, offline: true };
        if (device) {
            arduinoResult = await sendCommandToArduino(device.ip, device.port, 'lock', {
                lockerId: id,
                status: 'LOCKED'
            });
        }

        res.json({
            success: true,
            message: 'Locker locked',
            locker: updated,
            arduino: arduinoResult
        });

        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-iot',
            message: `Locker ${id} locked`,
            context: {
                lockerId: id
            },
            tags: ['iot', 'locker', 'lock'],
            severity: 'P3'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });

        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-iot',
            message: 'Locker lock error',
            error: {
                type: error.constructor.name,
                message: error.message
            },
            context: {
                lockerId: req.params.lockerId
            },
            tags: ['iot', 'locker', 'lock', 'error'],
            severity: 'P2'
        });
    }
});

// Unlock specific locker
app.post('/api/locker/:lockerId/unlock', async (req, res) => {
    try {
        const { lockerId } = req.params;
        const id = parseInt(lockerId);

        if (isNaN(id)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid locker ID'
            });
        }

        // Update database
        const updated = await updateLockerStatus(id, 'AVAILABLE');

        // Send command to Arduino
        const device = getArduinoByLocker(id);
        let arduinoResult = { success: true, offline: true };
        if (device) {
            arduinoResult = await sendCommandToArduino(device.ip, device.port, 'unlock', {
                lockerId: id,
                status: 'UNLOCKED'
            });
            console.log(`✓ Unlock command sent to Arduino for locker ${id}`);

            logger.info({
                timestamp: new Date().toISOString(),
                level: 'INFO',
                service: 'sewalokerbox-iot',
                message: `Unlock command sent to Arduino for locker ${id}`,
                context: {
                    lockerId: id,
                    ip: device.ip,
                    port: device.port
                },
                tags: ['iot', 'locker', 'unlock'],
                severity: 'P3'
            });
        } else {
            console.log(`⚠ No Arduino registered for locker ${id} - proceeding with software unlock only`);

            logger.warn({
                timestamp: new Date().toISOString(),
                level: 'WARN',
                service: 'sewalokerbox-iot',
                message: `No Arduino registered for locker ${id}`,
                context: {
                    lockerId: id
                },
                tags: ['iot', 'locker', 'unlock', 'missing-device'],
                severity: 'P3'
            });
        }

        res.json({
            success: true,
            message: 'Locker unlocked',
            locker: updated,
            arduino: arduinoResult
        });

        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-iot',
            message: `Locker ${id} unlocked`,
            context: {
                lockerId: id
            },
            tags: ['iot', 'locker', 'unlock'],
            severity: 'P3'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });

        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-iot',
            message: 'Locker unlock error',
            error: {
                type: error.constructor.name,
                message: error.message
            },
            context: {
                lockerId: req.params.lockerId
            },
            tags: ['iot', 'locker', 'unlock', 'error'],
            severity: 'P2'
        });
    }
});

// Get locker status
app.get('/api/locker/:lockerId/status', async (req, res) => {
    try {
        const { lockerId } = req.params;
        const id = parseInt(lockerId);
        const { db } = await connectToDatabase();

        const station = await db.collection('locker_stations').findOne({ "boxes.legacy_locker_id": id });
        const box = station?.boxes.find(b => b.legacy_locker_id === id);

        if (!box) {
            return res.status(404).json({
                success: false,
                error: 'Locker not found'
            });
        }

        const locker = mapLocker(box);
        const device = getArduinoByLocker(id);

        res.json({
            success: true,
            locker: locker,
            arduino: device ? {
                connected: true,
                ip: device.ip,
                port: device.port,
                lastHeartbeat: device.lastHeartbeat
            } : {
                connected: false
            }
        });

        logger.debug({
            timestamp: new Date().toISOString(),
            level: 'DEBUG',
            service: 'sewalokerbox-iot',
            message: `Locker ${id} status checked`,
            context: {
                lockerId: id
            },
            tags: ['iot', 'locker', 'status'],
            severity: 'P4'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });

        logger.error({
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            service: 'sewalokerbox-iot',
            message: 'Locker status error',
            error: {
                type: error.constructor.name,
                message: error.message
            },
            context: {
                lockerId: req.params.lockerId
            },
            tags: ['iot', 'locker', 'status', 'error'],
            severity: 'P2'
        });
    }
});

// Get registered Arduino devices
app.get('/api/arduino/devices', (req, res) => {
    const devices = [];
    for (const [key, device] of arduinoDevices) {
        devices.push(device);
    }
    res.json({
        success: true,
        count: devices.length,
        devices
    });
});

// 8. Get All Users
app.get('/api/users', async (req, res) => {
    try {
        const { db } = await connectToDatabase();
        const usersDocs = await db.collection('users')
            .find()
            .sort({ created_at: -1 })
            .toArray();

        const users = usersDocs.map(mapUser);

        res.json({
            success: true,
            count: users.length,
            users: users
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 9. Get All Usage Transactions
app.get('/api/usages', async (req, res) => {
    try {
        const { db } = await connectToDatabase();
        const usagesDocs = await db.collection('transactions').aggregate([
            { $sort: { "timestamps.started_at": -1 } },
            { $limit: 100 },
            {
                $lookup: {
                    from: "users",
                    localField: "parties.owner_id",
                    foreignField: "_id",
                    as: "user_info"
                }
            },
            {
                $lookup: {
                    from: "locker_stations",
                    localField: "box_reference.station_id",
                    foreignField: "_id",
                    as: "station_info"
                }
            }
        ]).toArray();

        const usages = usagesDocs.map(txn => {
            const user = txn.user_info[0] || null;
            const station = txn.station_info[0] || null;
            const box = station?.boxes.find(b => b.box_id.toString() === txn.box_reference.box_id?.toString()) || null;

            return {
                id: txn._id.toString(),
                category: txn.category,
                user_id: txn.parties.owner_id ? txn.parties.owner_id.toString() : null,
                sender_phone: txn.parties.sender_phone || null,
                courier_name: txn.parties.courier_name || null,
                resi_number: txn.parties.resi_number || null,
                recipient_phone: txn.parties.recipient_phone,
                pickup_code: txn.pickup_code,
                locker_id: txn.box_reference.legacy_locker_id || null,
                started_at: txn.timestamps.started_at,
                duration_plan: txn.duration_plan || null,
                ended_at: txn.timestamps.ended_at || null,
                base_fee: txn.fees.base_fee,
                extension_fee: txn.fees.extension_fee || 0,
                status: txn.status,
                size_type: box ? box.size_type : null,
                locker_status: box ? (box.is_available ? 'AVAILABLE' : 'OCCUPIED') : null,
                user_name: user ? user.full_name : null,
                user_phone: user ? user.phone_number : null
            };
        });

        res.json({
            success: true,
            count: usages.length,
            usages: usages
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 10. Dashboard Summary
app.get('/api/dashboard', async (req, res) => {
    try {
        const { db } = await connectToDatabase();

        const [ordersTotal, ordersPaid, usersTotal, usagesTotal, usagesActive, station] = await Promise.all([
            db.collection('orders').countDocuments(),
            db.collection('orders').countDocuments({ payment_status: 'PAID' }),
            db.collection('users').countDocuments(),
            db.collection('transactions').countDocuments(),
            db.collection('transactions').countDocuments({ status: 'ACTIVE' }),
            db.collection('locker_stations').findOne({ location_name: "Stasiun Pusat SewaLokerBox" })
        ]);

        const boxes = station ? station.boxes : [];
        const lockersTotal = boxes.length;
        const lockersAvailable = boxes.filter(b => b.is_available).length;
        const lockersOccupied = boxes.filter(b => !b.is_available).length;

        res.json({
            success: true,
            dashboard: {
                orders: {
                    total: ordersTotal,
                    paid: ordersPaid
                },
                users: {
                    total: usersTotal
                },
                usages: {
                    total: usagesTotal,
                    active: usagesActive
                },
                lockers: {
                    total: lockersTotal,
                    available: lockersAvailable,
                    occupied: lockersOccupied
                }
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// 7. Get All Orders (untuk monitoring)
app.get('/api/orders', async (req, res) => {
    try {
        const orders = await getAllOrders(50);

        res.json({
            success: true,
            count: orders.length,
            orders: orders
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health check
app.get('/api/health', async (req, res) => {
    let dbStatus = 'DISCONNECTED';
    try {
        const { db } = await connectToDatabase();
        await db.command({ ping: 1 });
        dbStatus = 'CONNECTED';
    } catch (e) {
        dbStatus = 'ERROR: ' + e.message;
    }

    res.json({
        success: true,
        message: 'Smart Locker API Running (MongoDB)',
        timestamp: new Date().toISOString(),
        midtrans: {
            mode: MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX',
            configured: !!MIDTRANS_SERVER_KEY
        },
        database: {
            status: dbStatus
        }
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.send(`
        <h1>Smart Locker API</h1>
        <p>Status: ✓ Running</p>
        <p>Midtrans Mode: ${MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'}</p>
        <br>
        <h3>Order & Payment:</h3>
        <ul>
            <li>GET /api/health - Health check</li>
            <li>GET /api/config - Get Midtrans client key</li>
            <li>POST /api/create-order - Create order & get snap token</li>
            <li>POST /api/webhook - Midtrans webhook</li>
            <li>GET /api/orders - Get all orders</li>
        </ul>
        <h3>NFC & Locker:</h3>
        <ul>
            <li>POST /api/tap - NFC tap (unlock locker)</li>
            <li>GET /api/pickup/:orderId - Get pickup code</li>
            <li>POST /api/register-nfc - Register NFC to user</li>
        </ul>
        <h3>Monitoring:</h3>
        <ul>
            <li>GET /api/lockers - All lockers</li>
            <li>GET /api/users - All users</li>
            <li>GET /api/usages - Usage history</li>
            <li>GET /api/dashboard - Dashboard</li>
        </ul>
    `);
});

// Centralized error handler middleware (must be registered after all routes)
app.use(errorHandler);

// =============================================
// DATABASE MIGRATION (One-time)
// =============================================
async function runMigrations() {
    try {
        const { db } = await connectToDatabase();
        console.log('✓ Database validation: MongoDB collections ready');
    } catch (err) {
        console.log('⚠ Database validation error:', err.message);
    }
}

runMigrations().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🚀 Server running on http://localhost:${PORT}`);
        console.log(`📱 Midtrans Mode: ${MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'}\n`);

        logger.info({
            timestamp: new Date().toISOString(),
            level: 'INFO',
            service: 'sewalokerbox-api',
            message: 'Server started',
            context: {
                port: PORT,
                midtransMode: MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'
            },
            tags: ['server', 'startup'],
            severity: 'P3'
        });
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    logger.info({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        service: 'sewalokerbox-api',
        message: 'Server shutting down',
        tags: ['server', 'shutdown'],
        severity: 'P3'
    });
    process.exit(0);
});

module.exports = app;