import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import rtfToHTML from '@iarna/rtf-to-html';
import { Readable } from 'stream';

const DOCS_DIR = '../test-data/Files/Docs';
const OUT_DIR = './output';

mkdirSync(OUT_DIR, { recursive: true });

// Test files covering different RTF complexity levels
const testFiles = [
  { id: '6',  desc: 'Narrative prose with poetry, curly quotes, dialogue' },
  { id: '45', desc: 'Brainstorming notes, mixed formatting, lists' },
  { id: '11', desc: 'Title page with RTF tables, template tags' },
  { id: '21', desc: 'Character sheet with bold fields, structured layout' },
];

function convertRtf(rtfBuffer) {
  return new Promise((resolve, reject) => {
    const stream = new Readable();
    stream.push(rtfBuffer);
    stream.push(null);

    rtfToHTML.fromStream(stream, (err, html) => {
      if (err) reject(err);
      else resolve(html);
    });
  });
}

console.log('RTF → HTML Conversion Fidelity Test');
console.log('Library: @iarna/rtf-to-html');
console.log('='.repeat(60));

for (const file of testFiles) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`File: ${file.id}.rtf — ${file.desc}`);
  console.log('─'.repeat(60));

  try {
    const rtf = readFileSync(`${DOCS_DIR}/${file.id}.rtf`);
    const html = await convertRtf(rtf);

    writeFileSync(`${OUT_DIR}/${file.id}.html`, html);

    // Show the raw HTML output
    console.log('\nHTML output:');
    console.log(html);

    // Quick fidelity checks
    const originalText = readFileSync(`${DOCS_DIR}/${file.id}.rtf`, 'utf8');

    // Check for curly quotes (RTF \'92, \'93, \'94)
    const hasCurlyQuotes = originalText.includes("\\'92") || originalText.includes("\\'93") || originalText.includes("\\'94");
    if (hasCurlyQuotes) {
      const quotesPreserved = html.includes('\u2018') || html.includes('\u2019') ||
                              html.includes('\u201C') || html.includes('\u201D') ||
                              html.includes('&#x2018') || html.includes('&#x2019') ||
                              html.includes('&#x201C') || html.includes('&#x201D') ||
                              html.includes('\u2019') || html.includes('\u2018');
      console.log(`\nCurly quotes in source: YES → Preserved in HTML: ${quotesPreserved ? 'YES' : 'NO (check manually)'}`);
    }

    // Check for bold
    const hasBold = originalText.includes('\\b ') || originalText.includes('\\b\n');
    if (hasBold) {
      const boldPreserved = html.includes('<b>') || html.includes('<strong>') ||
                            html.includes('font-weight');
      console.log(`Bold in source: YES → Preserved in HTML: ${boldPreserved ? 'YES' : 'NO'}`);
    }

    // Check for tables
    const hasTables = originalText.includes('\\trowd') || originalText.includes('\\itap');
    if (hasTables) {
      const tablesPreserved = html.includes('<table') || html.includes('<td');
      console.log(`Tables in source: YES → Preserved in HTML: ${tablesPreserved ? 'YES' : 'NO'}`);
    }

    // Check for template tags
    const hasTemplateTags = originalText.includes('<$');
    if (hasTemplateTags) {
      const tagsPreserved = html.includes('<$');
      console.log(`Template tags in source: YES → Preserved in HTML: ${tagsPreserved ? 'YES' : 'NO'}`);
    }

    // Em dash check
    const hasEmDash = originalText.includes("\\'97");
    if (hasEmDash) {
      const emDashPreserved = html.includes('\u2014') || html.includes('&mdash;') || html.includes('&#x2014');
      console.log(`Em dashes in source: YES → Preserved in HTML: ${emDashPreserved ? 'YES' : 'NO (check manually)'}`);
    }

  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Output HTML files written to ${OUT_DIR}/`);
