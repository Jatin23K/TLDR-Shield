const fs = require('fs');
const path = require('path');

const LOW_TEXT = `
Newsletter Privacy Policy
We collect your email address purely to send you our weekly update. We use Mailchimp to deliver these emails. 
We do not sell your personal information to third parties. 
We retain your email address until you click 'unsubscribe' in any email, at which point your data is deleted from our active lists. 
We do not use your data for AI training or automated profiling. 
Our goal is to be transparent and protect your privacy. 
These terms were last updated in April 2026.
`;

const DDG_PATH = path.resolve(__dirname, '..', '.system_generated', 'steps', '2371', 'content.md');
const GOOGLE_PATH = path.resolve(__dirname, '..', '.system_generated', 'steps', '2377', 'content.md');

async function runScan(name, text, tier) {
    console.log(`\n>>> RUNNING SCAN: ${name} [${tier.toUpperCase()}]`);
    try {
        const response = await fetch('http://localhost:8080/api/test-scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, tier })
        });
        const reader = response.body.getReader();
        let result = '';
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = new TextDecoder().decode(value);
            const matches = chunk.match(/data: (\{.*\})/g);
            if (matches) {
                for (const m of matches) {
                    const json = JSON.parse(m.replace('data: ', ''));
                    if (json.status === 'Complete') {
                        result = json;
                    }
                }
            }
        }
        return result;
    } catch (e) {
        console.error(`Scan failed: ${e.message}`);
        return null;
    }
}

async function main() {
    const ddgText = fs.readFileSync(DDG_PATH, 'utf8');
    const googleText = fs.readFileSync(GOOGLE_PATH, 'utf8');

    const services = [
        { name: 'Low (Newsletter)', text: LOW_TEXT },
        { name: 'Medium (DuckDuckGo)', text: ddgText },
        { name: 'High (Google)', text: googleText }
    ];

    const report = [];

    for (const service of services) {
        const quick = await runScan(service.name, service.text, 'quick');
        const deep = await runScan(service.name, service.text, 'deep');
        report.push({ service: service.name, quick, deep });
    }

    fs.writeFileSync(path.resolve(__dirname, 'test_results.json'), JSON.stringify(report, null, 2));
    console.log('\n\nFinal Report Generated: test_results.json');
}

main();
