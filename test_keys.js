import dotenv from 'dotenv';

// Force override to ensure we get the latest keys from .env, not cached shell envs
dotenv.config({ override: true });

const keysToTest = [
    { name: 'GEMINI_SCAN_KEY_1', value: process.env.GEMINI_SCAN_KEY_1 },
    { name: 'GEMINI_SCAN_KEY_2', value: process.env.GEMINI_SCAN_KEY_2 },
    { name: 'GEMINI_SCAN_KEY_3', value: process.env.GEMINI_SCAN_KEY_3 },
    { name: 'GEMINI_UTIL_KEY_1', value: process.env.GEMINI_UTIL_KEY_1 },
    { name: 'GEMINI_UTIL_KEY_2', value: process.env.GEMINI_UTIL_KEY_2 },
    { name: 'GEMINI_UTIL_KEY_3', value: process.env.GEMINI_UTIL_KEY_3 },
    { name: 'GEMINI_API_KEY', value: process.env.GEMINI_API_KEY },
    { name: 'GEMINI_API_KEY_2', value: process.env.GEMINI_API_KEY_2 },
    { name: 'GEMINI_API_KEY_3', value: process.env.GEMINI_API_KEY_3 },
    { name: 'GEMINI_API_KEY_4', value: process.env.GEMINI_API_KEY_4 },
    { name: 'GEMINI_API_KEY_5', value: process.env.GEMINI_API_KEY_5 },
    { name: 'GEMINI_API_KEY_6', value: process.env.GEMINI_API_KEY_6 }
];

async function testKeys() {
    console.log("Starting Key Accessibility & Validity Check for 12 Keys...");
    console.log("--------------------------------------------------");

    let validCount = 0;
    for (const keyObj of keysToTest) {
        const { name, value } = keyObj;
        
        if (!value) {
            console.log(`❌ ${name}: NOT FOUND IN .ENV`);
            continue;
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${value.trim()}`;
        const body = {
            contents: [{ parts: [{ text: "Hello, are you there?" }] }]
        };

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (res.ok) {
                console.log(`✅ ${name}: VALID AND ACTIVE (HTTP 200)`);
                validCount++;
            } else {
                const errorText = await res.text();
                let errMsg = errorText;
                try {
                    const json = JSON.parse(errorText);
                    errMsg = json.error?.message || errorText;
                } catch(e) {}
                console.log(`❌ ${name}: INVALID (HTTP ${res.status}) - ${errMsg}`);
            }
        } catch (error) {
            console.log(`❌ ${name}: NETWORK ERROR - ${error.message}`);
        }
    }
    console.log("--------------------------------------------------");
    console.log(`Total Valid Keys: ${validCount} / 12`);
}

testKeys();
