/**
 * 两账对账与礁区归属解析（纯函数，不触碰数据库）。
 *
 * 保护站账：sites（站位编号 no + 归属礁区 reefId）。
 * 外业队账：belts.attribSiteNo / attribReefId / attribStatus。
 * 两边一律按「站位编号」对账；对不上的样带在外业侧挂起（suspended），等人定。
 */
import type { Belt } from '@/types/belt'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { ReconIssueKind, ReconRow, ReefTransfer } from '@/types/transfer'

/** 站位编号 → 保护站账归属结果（编号只在礁区内唯一，重号时给出全部候选） */
export interface ManagerLedgerEntry {
  siteNo: string
  /** 该编号对应的全部站位（正常长度 1，跨礁区重号长度 > 1） */
  sites: Site[]
}

/** 按站位编号建立保护站账索引（编号跨礁区可能重号，仅用于物理站位缺失时辅助判歧义） */
export function buildManagerLedger(sites: Site[]): Map<string, ManagerLedgerEntry> {
  const ledger = new Map<string, ManagerLedgerEntry>()
  sites.forEach((site) => {
    const entry = ledger.get(site.no) ?? { siteNo: site.no, sites: [] }
    entry.sites.push(site)
    ledger.set(site.no, entry)
  })
  return ledger
}

/**
 * 解析一条样带当前应计入的礁区：
 * - suspended：挂起，不计入任何礁区结论（返回 null）
 * - 以样带物理站位（belt.siteId）为锚，再按站位编号对账：
 *   外业账 attribSiteNo 必须等于该站位编号、attribReefId 必须等于保护站账该站位的礁区；
 *   任一不一致（含划转撤回后两账错位）都不进礁区结论，挂起等人定。
 * - 站位编号跨礁区重号不影响此判定，因为样带物理挂点已唯一确定站位。
 */
export function effectiveBeltReefId(belt: Belt, siteById: Map<string, Site>): string | null {
  if (belt.attribStatus === 'suspended') return null
  const physicalSite = siteById.get(belt.siteId)
  if (!physicalSite) return null
  if (belt.attribSiteNo !== physicalSite.no) return null
  if (belt.attribReefId !== physicalSite.reefId) return null
  return belt.attribReefId
}

/** 全量对账：逐条样带给出 ReconRow（以物理站位为锚，按站位编号核对两账） */
export function reconcileBelts(belts: Belt[], sites: Site[]): ReconRow[] {
  const ledger = buildManagerLedger(sites)
  const siteById = new Map(sites.map((site) => [site.id, site]))
  return belts.map((belt) => {
    const physicalSite = siteById.get(belt.siteId)
    let issue: ReconIssueKind | null = null
    let detail = ''

    if (!physicalSite) {
      const candidates = ledger.get(belt.attribSiteNo)?.sites ?? []
      if (candidates.length > 1) {
        issue = 'manager-site-ambiguous'
        detail = `样带挂载站位已缺失，且站位编号 ${belt.attribSiteNo} 跨礁区重号，无法唯一定位`
      } else {
        issue = 'site-missing'
        detail = `样带挂载的站位已不存在，按站位编号 ${belt.attribSiteNo} 无法定位`
      }
    } else if (belt.attribSiteNo !== physicalSite.no) {
      issue = 'reef-mismatch'
      detail = `外业账站位编号 ${belt.attribSiteNo} 与保护站账该站位编号 ${physicalSite.no} 对不上`
    } else if (belt.attribReefId !== physicalSite.reefId) {
      issue = 'reef-mismatch'
      detail =
        belt.attribStatus === 'suspended'
          ? '样带已挂起：外业账归属礁区与保护站账不一致，等待人工裁定'
          : '外业账归属礁区与保护站账不一致（常见于保护站划转已撤回），暂不计入结论'
    }

    const matched = issue === null && belt.attribStatus === 'active'
    return {
      beltId: belt.id,
      beltNo: belt.no,
      siteId: belt.siteId,
      siteNo: physicalSite?.no ?? belt.attribSiteNo ?? '—',
      managerReefId: physicalSite?.reefId ?? '',
      fieldReefId: belt.attribReefId,
      matched,
      status: belt.attribStatus,
      issue,
      detail: detail || '两账按站位编号对得上'
    }
  })
}

/** 由各条目状态汇总划转单整体状态 */
export function summarizeTransferStatus(
  items: Array<{ managerStatus: string; fieldStatus: string }>
): 'pending' | 'applied' | 'partial' | 'reverted' {
  if (items.length === 0) return 'pending'
  const managers = items.map((item) => item.managerStatus)
  if (managers.every((status) => status === 'reverted')) return 'reverted'
  if (managers.some((status) => status === 'pending' || status === 'failed')) return 'pending'
  const fields = items.map((item) => item.fieldStatus)
  if (fields.some((status) => status === 'pending' || status === 'failed' || status === 'reverted')) {
    return 'partial'
  }
  return 'applied'
}

/** 生成划转单编号：TR-YYYYMMDD-序号 */
export function nextTransferNo(existing: ReefTransfer[], now = new Date()): string {
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate()
  ).padStart(2, '0')}`
  const prefix = `TR-${day}-`
  const seq = existing
    .filter((item) => item.no.startsWith(prefix))
    .map((item) => Number(item.no.slice(prefix.length)))
    .filter((value) => Number.isFinite(value))
  const next = (seq.length === 0 ? 0 : Math.max(...seq)) + 1
  return `${prefix}${String(next).padStart(3, '0')}`
}

/** 礁区 id → 名称的便捷查表 */
export function reefNameMap(reefs: Reef[]): Map<string, string> {
  return new Map(reefs.map((reef) => [reef.id, reef.name]))
}
