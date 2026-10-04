/**
 * v2 → v3 升级迁移验证：先建 v2 结构并写入无归属字段的旧样带，
 * 再以 v3 打开，确认按当时站位礁区回填；找不到站位的样带挂起。
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

let failures = 0
function assert(cond: boolean, message: string): void {
  if (cond) console.log(`  ✅ ${message}`)
  else {
    failures += 1
    console.error(`  ❌ ${message}`)
  }
}

async function main(): Promise<void> {
  // 1) 以 v2 建库并灌旧结构数据（belts 无 attrib* 字段）
  const legacyName = 'gbcoralbelt-migration-test'
  await new Promise<void>((resolve, reject) => {
    const db = new Dexie(legacyName)
    db.version(2).stores({
      reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
      sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
      belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
      corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
      fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
    })
    db.open()
      .then(async () => {
        await db.table('reefs').bulkPut([
          { id: 'r1', name: '甲礁区', protectStatus: '核心区', createdAt: 1, updatedAt: 1 },
          { id: 'r2', name: '乙礁区', protectStatus: '缓冲区', createdAt: 1, updatedAt: 1 }
        ])
        await db.table('sites').bulkPut([
          { id: 's1', reefId: 'r1', no: 'S-01', createdAt: 1, updatedAt: 1 },
          { id: 's2', reefId: 'r2', no: 'S-02', createdAt: 1, updatedAt: 1 }
        ])
        await db.table('belts').bulkPut([
          // 正常旧样带：挂在 s1
          { id: 'b1', siteId: 's1', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-09-01', observer: '', createdAt: 1, updatedAt: 1 },
          // 异常旧样带：站位已不存在
          { id: 'b2', siteId: 'sGone', no: 'T-02', lengthM: 25, orientation: '东', surveyDate: '2026-09-02', observer: '', createdAt: 1, updatedAt: 1 }
        ])
        await db.close()
        resolve()
      })
      .catch(reject)
  })

  // 2) 用应用侧 CoralBeltDatabase（v3）打开同一库名，触发 upgrade
  const { CoralBeltDatabase } = await import('@/utils/db')
  const db3 = new CoralBeltDatabase(legacyName)
  await db3.open()
  const b1 = await db3.belts.get('b1')
  const b2 = await db3.belts.get('b2')

  assert(b1!.attribSiteNo === 'S-01', 'b1 按当时站位回填编号 S-01')
  assert(b1!.attribReefId === 'r1', 'b1 按当时礁区回填归属 r1')
  assert(b1!.attribStatus === 'active', 'b1 回填为 active')
  assert(String(b1!.attribReason).includes('回填'), 'b1 带回填说明')
  assert(b2!.attribStatus === 'suspended', 'b2 找不到站位 → 挂起')
  assert(b2!.attribReefId === '', 'b2 归属礁区为空')

  await db3.close()
  console.log(failures === 0 ? '\nv2→v3 迁移断言通过 ✅' : `\n${failures} 条失败 ❌`)
  if (failures > 0) process.exitCode = 1
}

void main()
