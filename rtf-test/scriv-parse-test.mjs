import { readFileSync, existsSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import rtfToHTML from '@iarna/rtf-to-html';
import { Readable } from 'stream';

const SCRIV_DIR = '../test-data';
const DOCS_DIR = `${SCRIV_DIR}/Files/Docs`;

// ─── XML Parsing ──────────────────────────────────────────

const xml = readFileSync(`${SCRIV_DIR}/Talamus.scrivx`, 'utf8');
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => name === 'BinderItem' || name === 'Label' || name === 'Status',
});
const project = parser.parse(xml);

// ─── Label & Status lookup maps ──────────────────────────

const labels = {};
const labelItems = project.ScrivenerProject.LabelSettings.Labels.Label;
for (const l of labelItems) {
  labels[l['@_ID']] = l['#text'];
}

const statuses = {};
const statusItems = project.ScrivenerProject.StatusSettings.StatusItems.Status;
for (const s of statusItems) {
  statuses[s['@_ID']] = s['#text'];
}

console.log('Labels:', labels);
console.log('Statuses:', statuses);
console.log('Template Folder ID:', project.ScrivenerProject.TemplateFolderID);
console.log();

// ─── RTF conversion helper ───────────────────────────────

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

// ─── Tree walker ─────────────────────────────────────────

function walkBinder(items, depth = 0) {
  const nodes = [];
  if (!items) return nodes;

  // Ensure array
  const list = Array.isArray(items) ? items : [items];

  for (const item of list) {
    const id = item['@_ID'];
    const type = item['@_Type'];
    const title = item.Title || '(untitled)';
    const created = item['@_Created'];
    const modified = item['@_Modified'];

    const meta = item.MetaData || {};
    const labelId = meta.LabelID;
    const statusId = meta.StatusID;
    const includeInCompile = meta.IncludeInCompile === 'Yes';
    const compileAsIs = meta.CompileAsIs === 'Yes';
    const fileExt = meta.FileExtension;

    // Check for files on disk
    const contentFile = `${DOCS_DIR}/${id}.rtf`;
    const notesFile = `${DOCS_DIR}/${id}_notes.rtf`;
    const synopsisFile = `${DOCS_DIR}/${id}_synopsis.txt`;
    const mediaFile = fileExt ? `${DOCS_DIR}/${id}.${fileExt}` : null;

    const hasContent = existsSync(contentFile);
    const hasNotes = existsSync(notesFile);
    const hasSynopsis = existsSync(synopsisFile);
    const hasMedia = mediaFile && existsSync(mediaFile);

    const node = {
      id,
      type,
      title,
      depth,
      created,
      modified,
      label: labelId ? labels[labelId] || `Unknown(${labelId})` : null,
      status: statusId ? statuses[statusId] || `Unknown(${statusId})` : null,
      includeInCompile,
      compileAsIs,
      files: {
        content: hasContent ? contentFile : null,
        notes: hasNotes ? notesFile : null,
        synopsis: hasSynopsis ? synopsisFile : null,
        media: hasMedia ? mediaFile : null,
      },
      children: [],
    };

    // Recurse into children
    if (item.Children?.BinderItem) {
      node.children = walkBinder(item.Children.BinderItem, depth + 1);
    }

    nodes.push(node);
  }
  return nodes;
}

// ─── Parse the tree ──────────────────────────────────────

const binderItems = project.ScrivenerProject.Binder.BinderItem;
const tree = walkBinder(binderItems);

// ─── Print the tree ──────────────────────────────────────

function printTree(nodes, indent = '') {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const isLast = i === nodes.length - 1;
    const prefix = indent + (isLast ? '└── ' : '├── ');
    const childIndent = indent + (isLast ? '    ' : '│   ');

    const fileIndicators = [];
    if (node.files.content) fileIndicators.push('RTF');
    if (node.files.notes) fileIndicators.push('notes');
    if (node.files.synopsis) fileIndicators.push('synopsis');
    if (node.files.media) fileIndicators.push('media');

    const metaParts = [];
    if (node.label) metaParts.push(`label:${node.label}`);
    if (node.status) metaParts.push(`status:${node.status}`);
    if (node.compileAsIs) metaParts.push('compile-as-is');
    if (fileIndicators.length) metaParts.push(`[${fileIndicators.join(', ')}]`);

    const meta = metaParts.length ? ` (${metaParts.join(', ')})` : '';
    console.log(`${prefix}[${node.type}:${node.id}] ${node.title}${meta}`);

    if (node.children.length > 0) {
      printTree(node.children, childIndent);
    }
  }
}

console.log('═'.repeat(70));
console.log('RECONSTRUCTED BINDER TREE');
console.log('═'.repeat(70));
printTree(tree);

// ─── Convert all RTF content files ───────────────────────

console.log('\n' + '═'.repeat(70));
console.log('RTF CONVERSION RESULTS');
console.log('═'.repeat(70));

async function convertAll(nodes) {
  for (const node of nodes) {
    if (node.files.content) {
      try {
        const rtf = readFileSync(node.files.content);
        const html = await convertRtf(rtf);

        // Strip HTML wrapper to get just the body content
        const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
        const bodyContent = bodyMatch ? bodyMatch[1].trim() : html;
        const textLength = bodyContent.replace(/<[^>]+>/g, '').trim().length;
        const wordCount = bodyContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;

        console.log(`  ✓ [${node.id}] ${node.title} — ${wordCount} words, ${textLength} chars`);
      } catch (err) {
        console.log(`  ✗ [${node.id}] ${node.title} — ERROR: ${err.message}`);
      }
    }

    // Also note synopsis content if present
    if (node.files.synopsis) {
      const synopsis = readFileSync(node.files.synopsis, 'utf8').trim();
      if (synopsis) {
        console.log(`    ↳ synopsis: "${synopsis.substring(0, 80)}${synopsis.length > 80 ? '...' : ''}"`);
      }
    }

    // Convert notes too
    if (node.files.notes) {
      try {
        const rtf = readFileSync(node.files.notes);
        const html = await convertRtf(rtf);
        const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
        const bodyContent = bodyMatch ? bodyMatch[1].trim() : html;
        const wordCount = bodyContent.replace(/<[^>]+>/g, '').trim().split(/\s+/).filter(Boolean).length;
        console.log(`    ↳ notes: ${wordCount} words`);
      } catch (err) {
        console.log(`    ↳ notes: ERROR: ${err.message}`);
      }
    }

    await convertAll(node.children);
  }
}

await convertAll(tree);

// ─── Summary ─────────────────────────────────────────────

function countNodes(nodes) {
  let counts = { total: 0, text: 0, folder: 0, image: 0, pdf: 0, withContent: 0, withNotes: 0, withSynopsis: 0 };
  for (const node of nodes) {
    counts.total++;
    if (node.type === 'Text') counts.text++;
    else if (node.type.includes('Folder')) counts.folder++;
    else if (node.type === 'Image') counts.image++;
    else if (node.type === 'PDF') counts.pdf++;
    if (node.files.content) counts.withContent++;
    if (node.files.notes) counts.withNotes++;
    if (node.files.synopsis) counts.withSynopsis++;
    const childCounts = countNodes(node.children);
    for (const key of Object.keys(counts)) counts[key] += childCounts[key];
  }
  return counts;
}

const counts = countNodes(tree);
console.log('\n' + '═'.repeat(70));
console.log('SUMMARY');
console.log('═'.repeat(70));
console.log(`Total binder items:  ${counts.total}`);
console.log(`  Text documents:    ${counts.text}`);
console.log(`  Folders:           ${counts.folder}`);
console.log(`  Images:            ${counts.image}`);
console.log(`  PDFs:              ${counts.pdf}`);
console.log(`  With RTF content:  ${counts.withContent}`);
console.log(`  With notes:        ${counts.withNotes}`);
console.log(`  With synopsis:     ${counts.withSynopsis}`);
