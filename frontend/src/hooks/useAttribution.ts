/**
 * useAttribution：以「外业队归属账 + 站位编号对账」为唯一口径，
 * 给礁区白化结论、覆盖度汇总与划转页提供样带归属解析。
 *
 * - 对得上的样带按 attribReefId 计入礁区；
 * - 挂起 / 两账对不上的样带不计入任何礁区，集中在 pendingRows 等人定。
 */
import { computed, type ComputedRef } from 'vue'
import { storeToRefs } from 'pinia'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { effectiveBeltReefId, reconcileBelts } from '@/utils/attribution'
import type { ReconRow } from '@/types/transfer'

export interface BeltAttribution extends ReconRow {
  /** 计入结论的礁区 id；挂起/对不上为 null */
  effectiveReefId: string | null
}

export interface UseAttributionResult {
  /** 全部样带的归属解析（含挂起） */
  rows: ComputedRef<BeltAttribution[]>
  /** 挂起 / 两账对不上、等人定的样带 */
  pendingRows: ComputedRef<BeltAttribution[]>
  /** 当前挂起样带数 */
  pendingCount: ComputedRef<number>
  /** 计入某礁区结论的样带 id 集合 */
  beltIdsForReef: (reefId: string) => ComputedRef<Set<string>>
  /** 单条样带计入的礁区 id */
  effectiveReefIdOfBelt: (beltId: string) => string | null
}

export function useAttribution(): UseAttributionResult {
  const reefStore = useReefStore()
  const beltStore = useBeltStore()
  const { sites } = storeToRefs(reefStore)
  const { belts } = storeToRefs(beltStore)

  const rows = computed<BeltAttribution[]>(() => {
    const siteById = new Map(sites.value.map((site) => [site.id, site]))
    return reconcileBelts(belts.value, sites.value).map((row) => ({
      ...row,
      effectiveReefId: (() => {
        const belt = belts.value.find((item) => item.id === row.beltId)
        return belt ? effectiveBeltReefId(belt, siteById) : null
      })()
    }))
  })

  const pendingRows = computed<BeltAttribution[]>(() =>
    rows.value.filter((row) => row.effectiveReefId === null)
  )

  const pendingCount = computed(() => pendingRows.value.length)

  function beltIdsForReef(reefId: string): ComputedRef<Set<string>> {
    return computed(
      () => new Set(rows.value.filter((row) => row.effectiveReefId === reefId).map((row) => row.beltId))
    )
  }

  function effectiveReefIdOfBelt(beltId: string): string | null {
    return rows.value.find((row) => row.beltId === beltId)?.effectiveReefId ?? null
  }

  return { rows, pendingRows, pendingCount, beltIdsForReef, effectiveReefIdOfBelt }
}
