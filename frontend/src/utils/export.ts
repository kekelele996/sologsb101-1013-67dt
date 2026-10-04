/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import type { Belt } from '@/types/belt'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'
import { effectiveBeltReefId } from '@/utils/attribution'

/** 备份集合键名（v3 起含 transfers） */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes, transfers] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray(),
    db.transfers.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    corals,
    fishes,
    transfers
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  for (const key of BACKUP_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? [],
    transfers: Array.isArray(obj.transfers) ? obj.transfers : []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 导入快照：overwrite=true 先清空全部表，否则按主键合并。
 * 旧备份（v2 及以前）的样带没有归属记录，导入时按「当时站位 → 礁区」回填一版，
 * 与数据库升级迁移保持同一口径。
 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const belts = payload.belts.map((belt) => {
    if (
      typeof belt.attribSiteNo === 'string' &&
      typeof belt.attribReefId === 'string' &&
      (belt.attribStatus === 'active' || belt.attribStatus === 'suspended')
    ) {
      return belt
    }
    const site = siteById.get(belt.siteId)
    return {
      ...belt,
      attribSiteNo: site ? site.no : belt.no,
      attribReefId: site ? site.reefId : '',
      attribStatus: site ? ('active' as const) : ('suspended' as const),
      attribReason: site ? '导入旧备份时按当时礁区回填归属' : '导入旧备份时找不到站位，挂起待人工裁定',
      attribUpdatedAt: 0
    }
  })
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.transfers],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(belts)
      await db.corals.bulkPut(payload.corals)
      await db.fishes.bulkPut(payload.fishes)
      if (payload.transfers && payload.transfers.length > 0) await db.transfers.bulkPut(payload.transfers)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    const remappedSiteId = siteMap.get(belt.siteId) ?? belt.siteId
    // 追加副本的外业归属账同样按重映射后的站位/礁区重建，避免串到既有账
    const remappedSite = payload.sites.find((site) => site.id === belt.siteId)
    return {
      ...belt,
      id,
      siteId: remappedSiteId,
      attribSiteNo: remappedSite?.no ?? belt.attribSiteNo ?? belt.no,
      attribReefId: reefMap.get(belt.attribReefId ?? '') ?? reefMap.get(remappedSite?.reefId ?? '') ?? belt.attribReefId ?? '',
      attribReason: belt.attribReason ?? '追加导入时按当时礁区回填归属'
    }
  })
  const corals = payload.corals.map((coral) => ({
    ...coral,
    id: createId('cor'),
    beltId: beltMap.get(coral.beltId) ?? coral.beltId
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  return { ...payload, reefs, sites, belts, corals, fishes }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度 */
export interface CoverageLine {
  beltId: string
  beltNo: string
  /** 计入结论的礁区 id；挂起/对不上为 ''（不计入任何礁区） */
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  /** 外业归属账状态 */
  attribStatus: Belt['attribStatus']
  /** 是否挂起 / 两账对不上，等待人工裁定 */
  pending: boolean
  pendingReason: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4 */
  bleachIndex: number
  /** 总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  conclusion: string
}

/** 按样带生成覆盖度结论行 */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const coralsByBelt = new Map<string, typeof payload.corals>()
  payload.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  return payload.belts
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      // 以外业归属账与保护站账按站位编号对账的结果决定计入哪个礁区
      const effectiveReefId = effectiveBeltReefId(belt, siteById)
      const pending = effectiveReefId === null
      const pendingReason = pending
        ? belt.attribStatus === 'suspended'
          ? belt.attribReason || '样带已挂起，等待人工裁定归属'
          : '外业账与保护站账按站位编号对不上，暂不计入礁区结论'
        : ''
      const reef = effectiveReefId ? reefById.get(effectiveReefId) : undefined
      const corals = coralsByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(corals)
      const grade = bleachGrade(index)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          corals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
      return {
        beltId: belt.id,
        beltNo: belt.no,
        reefId: reef?.id ?? '',
        reefName: pending ? '挂起 · 待人工定归属' : reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: belt.attribSiteNo || site?.no || '—',
        attribStatus: belt.attribStatus,
        pending,
        pendingReason,
        lengthM: belt.lengthM,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        coralCount: corals.length,
        coverCmTotal,
        coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
        bleachIndex: index,
        grade,
        bleachedSharePct: bleachedSharePct(corals),
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion: pending
          ? `样带归属挂起（${pendingReason}），暂不计入任何礁区白化结论`
          : corals.length === 0
            ? '该样带尚未录入珊瑚记录'
            : grade === '无'
              ? `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，未见白化`
              : `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(corals)}%`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级 */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
  /** 挂起 / 两账对不上、未计入本礁区的样带数 */
  pendingBeltCount: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  return payload.reefs.map((reef) => {
    // 站位/样带归属一律以覆盖度结论行的对账口径为准（划走的样带不再算在原礁区）
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    const beltIds = new Set(lines4Reef.map((line) => line.beltId))
    const siteNos = new Set(lines4Reef.map((line) => line.siteNo))
    const corals = payload.corals.filter((coral) => beltIds.has(coral.beltId))
    const avgBleachIndex =
      lines4Reef.length === 0
        ? 0
        : round(lines4Reef.reduce((sum, line) => sum + line.bleachIndex, 0) / lines4Reef.length, 2)
    // 本礁区保护站站位下、因两账对不上而挂起未计入的样带数
    const pendingBeltCount = lines.filter(
      (line) => line.pending && siteById.get(line.siteId)?.reefId === reef.id
    ).length
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: siteNos.size,
      beltCount: beltIds.size,
      coralCount: corals.length,
      coverCmTotal: round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      fishTotal: payload.fishes
        .filter((fish) => beltIds.has(fish.beltId))
        .reduce((sum, fish) => sum + fish.count, 0),
      pendingBeltCount
    }
  })
}
