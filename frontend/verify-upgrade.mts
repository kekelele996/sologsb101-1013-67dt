/**
 * v2 → v3 IndexedDB 升级验证（不入构建产物）：
 * 先用只含 v2 结构的 Dexie 写入旧数据（无 ownership，含一条缺站位的孤立样带），
 * 关闭后打开正式 v3 库，确认 upgrade 迁移按「样带 → 当时站位 → 当时礁区」回填归属快照且容错。
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import assert from 'node:assert/strict'

// @ts-expect-error - node 环境注入浏览器 API
globalThis.indexedDB = new IDBFactory()
// @ts-expect-error - node 环境注入浏览器 API
globalThis.IDBKeyRange = IDBKeyRange

const { DB_NAME, db } = await import('./src/utils/db.ts')
const Dexie = (await import('dexie')).default

const now = Date.now()

// 1) 以 v2 结构建旧库并写「旧数据」：belt1 正常、beltX 缺站位（孤立样带）
const legacy = new Dexie(DB_NAME)
legacy.version(2).stores({
  reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
  sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
  belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
  corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
  fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
})
await legacy.table('reefs').bulkPut([
  { id: 'reefA', name: '原礁区', location: '', areaKm2: 1, protectStatus: '核心区', manager: '', createdAt: now, updatedAt: now },
  { id: 'reefB', name: '相邻礁区', location: '', areaKm2: 2, protectStatus: '缓冲区', manager: '', createdAt: now, updatedAt: now }
])
await legacy.table('sites').bulkPut([
  { id: 'site1', reefId: 'reefA', no: 'S-01', lat: 1, lng: 1, depthM: 5, substrate: '岩礁', createdAt: now, updatedAt: now }
])
await legacy.table('belts').bulkPut([
  { id: 'belt1', siteId: 'site1', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-09-01', observer: '外业甲', createdAt: now, updatedAt: now },
  { id: 'beltX', siteId: 'missing-site', no: 'T-09', lengthM: 20, orientation: '东', surveyDate: '2026-09-02', observer: '', createdAt: now, updatedAt: now }
])
await legacy.close()

// 2) 正式打开 v3：触发 upgrade
await db.open()
const ownership = await db.ownership.toArray()
const transfers = await db.transfers.toArray()
assert(ownership.length === 2, `应回填 2 条归属，实际 ${ownership.length}`)
const normal = ownership.find((o) => o.beltId === 'belt1')
const orphan = ownership.find((o) => o.beltId === 'beltX')
assert(normal?.siteId === 'site1' && normal.siteNo === 'S-01' && normal.reefId === 'reefA', '正常样带按当时站位/礁区回填')
assert(normal?.lastTransferId === null, '回填记录 lastTransferId 为 null')
assert(orphan?.siteId === 'missing-site' && orphan.siteNo === '' && orphan.reefId === '', '孤立样带回填空编号/空礁区且不报错')
assert(transfers.length === 0, '旧库无划转单')

// 3) 验证索引可用：按 reefId / siteNo 能查到
const inA = await db.ownership.where('reefId').equals('reefA').toArray()
assert(inA.length === 1 && inA[0].beltId === 'belt1', 'reefId 索引可用')
const byNo = await db.ownership.where('siteNo').equals('S-01').toArray()
assert(byNo.length === 1, 'siteNo 索引可用')

console.log('✓ v2→v3 升级按当时礁区回填归属快照（含孤立样带容错与索引）')
console.log('\n升级迁移全部通过 ✅')
process.exit(0)
