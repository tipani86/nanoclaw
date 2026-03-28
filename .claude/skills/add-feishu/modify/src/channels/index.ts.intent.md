# Intent: src/channels/index.ts

## What changed
Added `import './feishu.js';` under the `// feishu` comment block.

## Invariants
- The `// whatsapp` import must remain present if WhatsApp is installed
- The `// feishu` section must be alphabetically ordered relative to other channel sections
- Each channel section has a comment `// <channel-name>` followed by the import on the next line
- Channels that are not installed have only the comment line (no import)

## Merge strategy
If the file has been modified since this skill was generated, insert the feishu import line
immediately after the `// feishu` comment. Do not remove any existing imports.
