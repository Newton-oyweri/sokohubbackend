import axios from 'axios';
// Helper function to format phone number for M-Pesa
const formatPhoneForMpesa = (phone) => {
    let cleaned = phone.replace(/[\s+\-()]/g, '');
    
    if (cleaned.startsWith('0')) {
        cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
        cleaned = '254' + cleaned;
    } else if (cleaned.startsWith('254')) {
        // Already in correct format
    } else {
        cleaned = '254' + cleaned;
    }
    
    return cleaned;
};

// Helper function to format Safaricom timestamps (YYYYMMDDHHmmss)
const getTimestamp = () => {
    const now = new Date();
    return now.getFullYear() +
        String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') +
        String(now.getHours()).padStart(2, '0') +
        String(now.getMinutes()).padStart(2, '0') +
        String(now.getSeconds()).padStart(2, '0');
};


// Middleware: Safaricom Authentication Handler
const generateToken = async (req, res, next) => {
    const secret = process.env.MPESA_CONSUMER_SECRET?.trim();
    const key = process.env.MPESA_CONSUMER_KEY?.trim();
    
    if (!secret || !key) {
        return res.status(500).json({ error: "Safaricom authentication keys are missing in your environment config." });
    }

    const auth = Buffer.from(`${key}:${secret}`).toString('base64');

    try {
        const response = await axios.get(
            'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
            { headers: { Authorization: `Basic ${auth}` } }
        );
        req.token = response.data.access_token;
        next();
    } catch (error) {
        console.error("M-Pesa Access Token Error:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to authenticate with Safaricom system gateway." });
    }
};

 export { formatPhoneForMpesa, getTimestamp, generateToken };
