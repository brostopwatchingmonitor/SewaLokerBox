require('dotenv').config();
const express = require('express');
const midtransClient = require('midtrans-client');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const app = express();

const JWT_SECRET = process.env.JWT_SECRET || 'sewaloker-secret-key-2024';

// =============================================
// DATABASE SETUP (Using pg for direct connection)
// =============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test connection on startup
pool.query('SELECT NOW()')
    .then(() => console.log('Database: ✓ Connected'))
    .catch(err => console.log('Database: ✗ Failed -', err.message));

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// =============================================
// HELPER FUNCTION
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
        console.error('Midtrans Token Creation Error:', error);
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

// --- User Functions ---
async function findUserByEmail(email) {
    const result = await pool.query(`
        SELECT * FROM "User" WHERE email = $1
    `, [email]);
    return result.rows[0] || null;
}

async function findUserByPhone(phone) {
    const result = await pool.query(`
        SELECT * FROM "User" WHERE phone_number = $1
    `, [phone]);
    return result.rows[0] || null;
}

async function findOrCreateUser(customerName, customerEmail, customerPhone) {
    // Try to find existing user by email or phone
    let result = await pool.query(`
        SELECT * FROM "User"
        WHERE email = $1 OR phone_number = $2
    `, [customerEmail, customerPhone]);

    if (result.rows.length > 0) {
        console.log('✓ Existing user found:', result.rows[0].id);
        return result.rows[0];
    }

    // Create new user
    const id = generateUUID();
    result = await pool.query(`
        INSERT INTO "User" (id, full_name, email, phone_number, balance, "createdAt")
        VALUES ($1, $2, $3, $4, 0, NOW())
        RETURNING *
    `, [id, customerName || 'Pelanggan', customerEmail, customerPhone]);

    console.log('✓ New user created:', result.rows[0].id);
    return result.rows[0];
}

async function updateUserBalance(userId, newBalance) {
    const result = await pool.query(`
        UPDATE "User" SET balance = $2 WHERE id = $1 RETURNING *
    `, [userId, newBalance]);
    return result.rows[0];
}

// --- Locker Functions ---
async function findAvailableLocker(sizeType) {
    // sizeType: "Small" maps to locker size S or M, "Large" maps to L
    let sizeMapping;
    if (sizeType === 'Small') {
        sizeMapping = ['S', 'M'];
    } else {
        sizeMapping = ['L'];
    }

    const result = await pool.query(`
        SELECT * FROM "Locker"
        WHERE size_type = ANY($1) AND status = 'AVAILABLE'
        LIMIT 1
    `, [sizeMapping]);

    if (result.rows.length > 0) {
        console.log('✓ Available locker found:', result.rows[0].id);
        return result.rows[0];
    }

    // If no locker available, return first locker of type
    const fallbackResult = await pool.query(`
        SELECT * FROM "Locker" WHERE size_type = ANY($1) LIMIT 1
    `, [sizeMapping]);

    return fallbackResult.rows[0] || null;
}

async function updateLockerStatus(lockerId, status) {
    const result = await pool.query(`
        UPDATE "Locker" SET status = $2 WHERE id = $1 RETURNING *
    `, [lockerId, status]);
    return result.rows[0];
}

// =============================================
// ARDUINO/IOT HELPER FUNCTIONS
// =============================================
const https = require('https');

// Store registered Arduino devices
let arduinoDevices = new Map();

// Send command to Arduino via HTTP
async function sendCommandToArduino(ip, port, command, data = {}) {
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
                    resolve(json);
                } catch (e) {
                    resolve({ success: true, message: body });
                }
            });
        });

        req.on('error', (err) => {
            console.log('Arduino communication error:', err.message);
            // Fallback: resolve as success since Arduino might be unreachable but will process later
            resolve({ success: false, error: err.message, offline: true });
        });

        req.on('timeout', () => {
            req.destroy();
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
    const { orderId, userId, lockerSize, duration, grossAmount, customerName, customerEmail, customerPhone } = orderData;
    const id = generateUUID();

    const result = await pool.query(`
        INSERT INTO "Order" (
            id, order_id, user_id, locker_size, duration, gross_amount, payment_status,
            customer_name, customer_email, customer_phone, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $9, NOW(), NOW())
        RETURNING id, order_id, payment_status
    `, [id, orderId, userId, lockerSize, duration, grossAmount, customerName, customerEmail, customerPhone]);

    return result.rows[0];
}

async function updateOrderWithUser(orderId, userId) {
    const result = await pool.query(`
        UPDATE "Order" SET user_id = $2, updated_at = NOW() WHERE order_id = $1 RETURNING *
    `, [orderId, userId]);
    return result.rows[0];
}

async function updateOrderStatus(orderId, paymentStatus, transactionId = null, lockerId = null) {
    let query = `
        UPDATE "Order"
        SET payment_status = $2, updated_at = NOW()
    `;
    let params = [orderId, paymentStatus];
    let paramIndex = 3;

    if (transactionId) {
        query += `, transaction_id = $${paramIndex}`;
        params.push(transactionId);
        paramIndex++;
    }

    if (paymentStatus === 'PAID') {
        query += `, payment_date = NOW()`;
    }

    query += ` WHERE order_id = $1 RETURNING *`;

    const result = await pool.query(query, params);
    return result.rows[0];
}

async function getOrderById(orderId) {
    const result = await pool.query(`SELECT * FROM "Order" WHERE order_id = $1`, [orderId]);
    return result.rows[0];
}

async function getAllOrders(limit = 50) {
    const result = await pool.query(`
        SELECT * FROM "Order"
        ORDER BY created_at DESC
        LIMIT $1
    `, [limit]);
    return result.rows;
}

// --- UsageTransaction Functions ---
// --- UsageTransaction Functions ---
async function createUsageTransaction(usageData) {
    const {
        userId,
        lockerId,
        recipientPhone,
        pickupCode,
        baseFee,
        durationPlan,
        orderId
    } = usageData;

    const id = generateUUID();

    // Get order details
    const order = await getOrderById(orderId);

    // FIX: Menghilangkan duplikasi started_at dan merapikan urutan kolom sesuai skema Prisma
    const result = await pool.query(`
        INSERT INTO "UsageTransaction" (
            id, category, user_id, recipient_phone, pickup_code,
            locker_id, duration_plan, base_fee, status, 
            started_at, ended_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', NOW(), NULL)
        RETURNING *
    `, [
        id,
        userId ? 'USER_DEPOSIT' : 'COURIER_DROP',
        userId,
        recipientPhone || order?.customer_phone,
        pickupCode,
        lockerId,
        durationPlan || order?.duration,
        baseFee || order?.gross_amount
    ]);

    console.log('✓ UsageTransaction created:', result.rows[0].id);
    return result.rows[0];
}

async function getUsageTransactionByPickupCode(pickupCode) {
    const result = await pool.query(`
        SELECT ut.*, l.size_type, l.status as locker_status
        FROM "UsageTransaction" ut
        JOIN "Locker" l ON ut.locker_id = l.id
        WHERE ut.pickup_code = $1
    `, [pickupCode]);
    return result.rows[0];
}

async function completeUsageTransaction(pickupCode) {
    const result = await pool.query(`
        UPDATE "UsageTransaction"
        SET ended_at = NOW(), status = 'COMPLETED'
        WHERE pickup_code = $1
        RETURNING *
    `, [pickupCode]);
    return result.rows[0];
}

// --- TopUpTransaction Functions ---
async function createTopUpTransaction(topUpData) {
    const { userId, amount, paymentStatus = 'PENDING' } = topUpData;
    const id = generateUUID();

    const result = await pool.query(`
        INSERT INTO "TopUpTransaction" (id, user_id, amount, payment_status, "createdAt")
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING *
    `, [id, userId, amount, paymentStatus]);

    return result.rows[0];
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
            return res.status(400).json({
                success: false,
                error: 'Semua field wajib diisi'
            });
        }

        // Check if user already exists
        const existingUser = await findUserByEmail(email);
        if (existingUser) {
            return res.status(400).json({
                success: false,
                error: 'Email sudah terdaftar'
            });
        }

        // Check if phone already exists
        const existingPhone = await findUserByPhone(phoneNumber);
        if (existingPhone) {
            return res.status(400).json({
                success: false,
                error: 'Nomor telepon sudah terdaftar'
            });
        }

        // Hash password
        const hashedPassword = await hashPassword(password);

        // Create user
        const id = generateUUID();
        const result = await pool.query(`
            INSERT INTO "User" (id, full_name, email, phone_number, password, balance, "createdAt")
            VALUES ($1, $2, $3, $4, $5, 0, NOW())
            RETURNING id, full_name, email, phone_number, "createdAt"
        `, [id, fullName, email, phoneNumber, hashedPassword]);

        const user = result.rows[0];
        const token = generateToken(user);

        console.log('✓ New user registered:', user.id);

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
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get current user profile
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, full_name, email, phone_number, balance, nfc_uid, "createdAt"
            FROM "User" WHERE id = $1
        `, [req.user.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'User tidak ditemukan'
            });
        }

        const user = result.rows[0];

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

        const result = await pool.query(`
            UPDATE "User" SET full_name = COALESCE($2, full_name), phone_number = COALESCE($3, phone_number)
            WHERE id = $1
            RETURNING id, full_name, email, phone_number
        `, [req.user.id, fullName, phoneNumber]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'User tidak ditemukan'
            });
        }

        const user = result.rows[0];

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

        // Get current user with password
        const result = await pool.query(`
            SELECT password FROM "User" WHERE id = $1
        `, [req.user.id]);

        if (result.rows.length === 0 || !result.rows[0].password) {
            return res.status(400).json({
                success: false,
                error: 'Akun belum memiliki password'
            });
        }

        // Verify current password
        const isValid = await comparePassword(currentPassword, result.rows[0].password);
        if (!isValid) {
            return res.status(401).json({
                success: false,
                error: 'Password lama salah'
            });
        }

        // Update password
        const hashedPassword = await hashPassword(newPassword);
        await pool.query(`
            UPDATE "User" SET password = $2 WHERE id = $1
        `, [req.user.id, hashedPassword]);

        res.json({
            success: true,
            message: 'Password berhasil diubah'
        });

    } catch (error) {
        console.error('Change Password Error:', error);
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

        let user;

        // 1. If authenticated user (via token), use that user
        const authHeader = req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            const token = authHeader.split(' ')[1];
            const decoded = verifyToken(token);
            if (decoded) {
                const userResult = await pool.query(`SELECT * FROM "User" WHERE id = $1`, [decoded.id]);
                if (userResult.rows.length > 0) {
                    user = userResult.rows[0];
                    console.log('✓ Authenticated user:', user.id);
                }
            }
        }

        // 2. If no authenticated user but userId provided, find by ID
        if (!user && userId) {
            const userResult = await pool.query(`SELECT * FROM "User" WHERE id = $1`, [userId]);
            if (userResult.rows.length > 0) {
                user = userResult.rows[0];
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
            await pool.query(`DELETE FROM "Order" WHERE id = $1`, [order.id]);
            res.status(500).json({
                success: false,
                error: result.error
            });
        }

    } catch (error) {
        console.error('API Error:', error);
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
        }

        res.status(200).json({
            success: true,
            orderId: orderId,
            status: transactionStatus,
            databaseUpdated: !!updatedOrder
        });

    } catch (error) {
        console.error("Webhook Error:", error);
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
        // Find user by NFC UID
        const userResult = await pool.query(`
            SELECT u.*, ut.pickup_code, ut.locker_id, ut.status as usage_status, ut.id as usage_id
            FROM "User" u
            LEFT JOIN "UsageTransaction" ut ON u.id = ut.user_id AND ut.status = 'ACTIVE'
            WHERE u.nfc_uid = $1
            ORDER BY ut."started_at" DESC
            LIMIT 1
        `, [nfc_uid]);

        if (userResult.rows.length > 0 && userResult.rows[0].pickup_code) {
            const usage = userResult.rows[0];

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
            }

            res.json({
                success: true,
                status: "UNLOCK_SUCCESS",
                message: "Locker berhasil dibuka",
                pickup_code: usage.pickup_code,
                user_name: userResult.rows[0].full_name,
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

        const result = await pool.query(`
            SELECT ut.*, l.size_type
            FROM "UsageTransaction" ut
            JOIN "Locker" l ON ut.locker_id = l.id
            JOIN "Order" o ON o.user_id = ut.user_id
            WHERE o.order_id = $1
            ORDER BY ut."started_at" DESC
            LIMIT 1
        `, [orderId]);

        if (result.rows.length > 0) {
            res.json({
                success: true,
                pickup_code: result.rows[0].pickup_code,
                locker_id: result.rows[0].locker_id,
                size_type: result.rows[0].size_type
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

        const result = await pool.query(`
            SELECT * FROM "User" WHERE nfc_uid = $1
        `, [nfcUid]);

        if (result.rows.length > 0) {
            res.json({
                success: true,
                user: result.rows[0]
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

        if (!userId || !nfcUid) {
            return res.status(400).json({
                success: false,
                error: 'userId and nfcUid are required'
            });
        }

        const result = await pool.query(`
            UPDATE "User" SET nfc_uid = $2 WHERE id = $1 RETURNING *
        `, [userId, nfcUid]);

        if (result.rows.length > 0) {
            res.json({
                success: true,
                message: 'NFC UID registered successfully',
                user: result.rows[0]
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
        const result = await pool.query(`
            SELECT * FROM "Locker" ORDER BY id
        `);

        res.json({
            success: true,
            count: result.rows.length,
            lockers: result.rows
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
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
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
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
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
        } else {
            console.log(`⚠ No Arduino registered for locker ${id} - proceeding with software unlock only`);
        }

        res.json({
            success: true,
            message: 'Locker unlocked',
            locker: updated,
            arduino: arduinoResult
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get locker status
app.get('/api/locker/:lockerId/status', async (req, res) => {
    try {
        const { lockerId } = req.params;
        const id = parseInt(lockerId);

        const result = await pool.query(`SELECT * FROM "Locker" WHERE id = $1`, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Locker not found'
            });
        }

        // Check if Arduino is connected
        const device = getArduinoByLocker(id);

        res.json({
            success: true,
            locker: result.rows[0],
            arduino: device ? {
                connected: true,
                ip: device.ip,
                port: device.port,
                lastHeartbeat: device.lastHeartbeat
            } : {
                connected: false
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
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
        const result = await pool.query(`
            SELECT id, full_name, email, phone_number, balance, nfc_uid, "createdAt"
            FROM "User"
            ORDER BY "createdAt" DESC
        `);

        res.json({
            success: true,
            count: result.rows.length,
            users: result.rows
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
        const result = await pool.query(`
            SELECT ut.*, l.size_type, l.status as locker_status,
                   u.full_name as user_name, u.phone_number as user_phone
            FROM "UsageTransaction" ut
            JOIN "Locker" l ON ut.locker_id = l.id
            LEFT JOIN "User" u ON ut.user_id = u.id
            ORDER BY ut."started_at" DESC
            LIMIT 100
        `);

        res.json({
            success: true,
            count: result.rows.length,
            usages: result.rows
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
        const [orders, users, usages, lockers] = await Promise.all([
            pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE payment_status = 'PAID') as paid FROM "Order"`),
            pool.query(`SELECT COUNT(*) as total FROM "User"`),
            pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'ACTIVE') as active FROM "UsageTransaction"`),
            pool.query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'AVAILABLE') as available, COUNT(*) FILTER (WHERE status = 'OCCUPIED') as occupied FROM "Locker"`)
        ]);

        res.json({
            success: true,
            dashboard: {
                orders: {
                    total: parseInt(orders.rows[0].total),
                    paid: parseInt(orders.rows[0].paid)
                },
                users: {
                    total: parseInt(users.rows[0].total)
                },
                usages: {
                    total: parseInt(usages.rows[0].total),
                    active: parseInt(usages.rows[0].active)
                },
                lockers: {
                    total: parseInt(lockers.rows[0].total),
                    available: parseInt(lockers.rows[0].available),
                    occupied: parseInt(lockers.rows[0].occupied)
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
        await pool.query('SELECT 1');
        dbStatus = 'CONNECTED';
    } catch (e) {
        dbStatus = 'ERROR: ' + e.message;
    }

    res.json({
        success: true,
        message: 'Smart Locker API Running',
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

// =============================================
// DATABASE MIGRATION (One-time)
async function runMigrations() {
    try {
        // Add password column if not exists
        await pool.query(`
            ALTER TABLE "User" ADD COLUMN IF NOT EXISTS password TEXT
        `);
        console.log('✓ Database migration: password column ready');
    } catch (err) {
        // Ignore if column already exists or other errors
        console.log('⚠ Database migration:', err.message);
    }
}

runMigrations().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🚀 Server running on http://localhost:${PORT}`);
        console.log(`📱 Midtrans Mode: ${MIDTRANS_IS_PRODUCTION ? 'PRODUCTION' : 'SANDBOX'}\n`);
    });
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    pool.end();
    process.exit(0);
});

module.exports = app;