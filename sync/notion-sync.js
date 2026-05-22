'use strict';
const { Client } = require('@notionhq/client');
const admin = require('firebase-admin');

// ── Init ──────────────────────────────────────────────────────────────────────
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_DATABASE_ID;

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});
const db = admin.firestore();

// ── Category maps ─────────────────────────────────────────────────────────────
const TO_KO = { work: '업무', personal: '개인', study: '공부' };
const TO_EN = { '업무': 'work', '개인': 'personal', '공부': 'study' };

// ── Notion property helpers ───────────────────────────────────────────────────
const nText   = (p, k) => p.properties[k]?.rich_text?.[0]?.plain_text ?? '';
const nTitle  = (p)    => p.properties['할 일']?.title?.[0]?.plain_text ?? '';
const nCheck  = (p, k) => p.properties[k]?.checkbox ?? false;
const nSelect = (p, k) => p.properties[k]?.select?.name ?? null;
const nDate   = (p, k) => p.properties[k]?.date?.start ?? null;

// ── Notion API helpers ────────────────────────────────────────────────────────
async function queryAllNotionPages() {
  const pages = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const p of res.results) {
      if (!p.archived) pages.push(p);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function buildNotionProps(todo, fbId, groupName, now) {
  const catKo = TO_KO[todo.category] ?? null;
  return {
    '할 일':      { title: [{ text: { content: todo.text ?? '' } }] },
    '카테고리':   catKo ? { select: { name: catKo } } : { select: null },
    '그룹':       { rich_text: [{ text: { content: groupName ?? '' } }] },
    '완료':       { checkbox: todo.done ?? false },
    'Firebase_ID':{ rich_text: [{ text: { content: fbId } }] },
    '수정일':     { date: { start: now } },
    ...(todo.createdAt && { '생성일': { date: { start: todo.createdAt } } }),
  };
}

// ── Main sync ─────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date().toISOString();

  // 1. Load Firebase groups
  const groupSnap = await db.collection('groups').get();
  const groupById  = {};
  const groupByName = {};
  groupSnap.forEach(doc => {
    const g = { id: doc.id, ...doc.data() };
    groupById[g.id]    = g;
    groupByName[g.name] = g;
  });

  // 2. Load Firebase todos
  const fbSnap = await db.collection('todos').get();
  const fbMap  = new Map();
  fbSnap.forEach(doc => fbMap.set(doc.id, { id: doc.id, ...doc.data() }));

  // 3. Load Notion pages
  const notionPages  = await queryAllNotionPages();
  const notionByFbId = new Map();
  const notionNew    = [];

  for (const page of notionPages) {
    const fbId = nText(page, 'Firebase_ID');
    if (fbId) notionByFbId.set(fbId, page);
    else       notionNew.push(page);
  }

  // ── Step 1: Firebase → Notion ─────────────────────────────────────────────
  for (const [fbId, todo] of fbMap) {
    // 휴지통 항목은 동기화 제외 (Step 3에서 Notion 페이지 보관 처리)
    if (todo.deletedAt) continue;

    const groupName = groupById[todo.groupId]?.name ?? todo.groupId ?? '';

    if (!notionByFbId.has(fbId)) {
      // Firebase todo not in Notion yet → create
      await notion.pages.create({
        parent: { database_id: DB_ID },
        properties: buildNotionProps(todo, fbId, groupName, now),
      });
      console.log(`[+Notion] ${fbId} "${todo.text}"`);
      continue;
    }

    // Both exist → compare timestamps to decide direction
    const page         = notionByFbId.get(fbId);
    const notionMod    = nDate(page, '수정일');
    const fbMod        = todo.updatedAt ?? todo.createdAt ?? '1970-01-01T00:00:00Z';

    if (notionMod && notionMod > fbMod) {
      // Notion is newer → update Firebase
      const updates = {
        done:      nCheck(page, '완료'),
        updatedAt: now,
      };
      const notionText = nTitle(page);
      const notionCat  = nSelect(page, '카테고리');
      if (notionText) updates.text     = notionText;
      if (notionCat)  updates.category = TO_EN[notionCat] ?? todo.category;

      await db.collection('todos').doc(fbId).update(updates);
      console.log(`[~Firebase] ${fbId} (Notion newer)`);
    } else {
      // Firebase is newer (or equal) → update Notion if different
      const fbDone  = todo.done ?? false;
      const fbCatKo = TO_KO[todo.category] ?? null;
      const changed =
        nCheck(page, '완료')        !== fbDone        ||
        nTitle(page)                 !== (todo.text ?? '') ||
        nSelect(page, '카테고리')    !== fbCatKo;

      if (changed) {
        await notion.pages.update({
          page_id: page.id,
          properties: {
            '할 일':    { title: [{ text: { content: todo.text ?? '' } }] },
            '카테고리': fbCatKo ? { select: { name: fbCatKo } } : { select: null },
            '완료':     { checkbox: fbDone },
            '수정일':   { date: { start: now } },
          },
        });
        console.log(`[~Notion] ${fbId} (Firebase newer)`);
      }
    }
  }

  // ── Step 2: Notion new → Firebase ────────────────────────────────────────
  for (const page of notionNew) {
    const text = nTitle(page);
    if (!text) continue;

    const catKo     = nSelect(page, '카테고리');
    const groupName = nText(page, '그룹');
    const group     = groupByName[groupName]?.id ?? 'default';

    const ref = await db.collection('todos').add({
      text,
      done:      nCheck(page, '완료'),
      category:  TO_EN[catKo] ?? 'personal',
      groupId:   group,
      createdAt: now,
      updatedAt: now,
    });

    await notion.pages.update({
      page_id: page.id,
      properties: {
        'Firebase_ID': { rich_text: [{ text: { content: ref.id } }] },
        '수정일':       { date: { start: now } },
      },
    });
    console.log(`[+Firebase] ${ref.id} "${text}" (from Notion)`);
  }

  // ── Step 3: Firebase 삭제/휴지통 → Notion 보관 ──────────────────────────────
  for (const [fbId, page] of notionByFbId) {
    const todo = fbMap.get(fbId);
    if (!todo || todo.deletedAt) {
      await notion.pages.update({ page_id: page.id, archived: true });
      console.log(`[-Notion] ${fbId} (${!todo ? 'deleted' : 'in trash'})`);
    }
  }

  console.log(`✓ Sync completed at ${now}`);
}

main().catch(err => {
  console.error('Sync failed:', err.message);
  process.exit(1);
});
