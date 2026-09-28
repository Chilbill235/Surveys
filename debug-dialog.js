const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');

for (const match of html.matchAll(/<dialog\b[^>]*>([\s\S]*?)<\/dialog>/g)) {
    const openingTag = match[0].slice(0, match[0].indexOf('>') + 1);
    const id = (/\bid="([^"]+)"/.exec(openingTag) || [, '?'])[1];
    const body = match[1];

    let depth = 0;
    const top = [];
    for (const tag of body.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b([^>]*?)(\/?)>/gi)) {
        const [, closing, name, attrs, self] = tag;
        if (self) {
            if (depth === 0) top.push(name);
            continue;
        }
        if (closing) {
            depth -= 1;
            continue;
        }
        if (depth === 0) top.push(name);
        depth += 1;
    }
    console.log(id, '-> top-level:', JSON.stringify(top), '| finalDepth:', depth);
}
