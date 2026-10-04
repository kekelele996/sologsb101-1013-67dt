<script setup lang="ts">
/**
 * 站位划转台账（/transfers）
 * 保护区界线调整后，把站位从原礁区划到相邻礁区：
 * - 管理站侧管界线 / 保护区状态 / 站位归属（sites.reefId）；
 * - 外业队侧管样带布设与珊瑚覆盖归属（ownership.reefId），样带跟着站位走；
 * - 两侧按站位编号（siteNo）独立对账，对不上的只挂起本侧等人定；
 * - 任一侧划转出问题只撤回本侧，另一侧照旧；旧数据无归属记录，升级时按当时礁区回填。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, RefreshLeft, Right, Select } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import TransferStatusTag from '@/components/common/TransferStatusTag.vue'
import { useReefStore } from '@/stores/reefStore'
import { useTransferStore } from '@/stores/transferStore'
import type { SideStatus, SiteTransfer } from '@/types/ownership'
import { overallStage } from '@/types/ownership'
import { TransferRuleError, type FieldSideSite } from '@/utils/transfer'
import type { Site } from '@/types/site'

type Side = 'station' | 'field'
type SideAction = 'reconcile' | 'apply' | 'withdraw'

const reefStore = useReefStore()
const transferStore = useTransferStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const form = reactive({
  siteNo: '',
  fromReefId: '',
  toReefId: '',
  remark: ''
})

const rows = computed(() =>
  transferStore.orderedTransfers.map((transfer) => ({
    transfer,
    stage: overallStage(transfer),
    fromReefName: reefStore.reefById(transfer.fromReefId)?.name ?? '未知礁区',
    toReefName: reefStore.reefById(transfer.toReefId)?.name ?? '未知礁区'
  }))
)

const stats = computed(() => ({
  total: transferStore.transfers.length,
  suspended: transferStore.suspendedCount,
  pending: transferStore.pendingCount,
  done: transferStore.transfers.filter((t) => overallStage(t) === 'done').length
}))

const reefOptions = computed(() =>
  reefStore.reefs.map((reef) => ({ label: `${reef.name}（${reef.protectStatus}）`, value: reef.id }))
)

function formatTime(ts: number | null): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function siteLabel(transfer: SiteTransfer, side: Side): string {
  const siteId = side === 'station' ? transfer.stationSiteId : transfer.fieldSiteId
  if (!siteId) return '—'
  const site = reefStore.siteById(siteId)
  return site ? `${site.no}（${site.id}）` : siteId
}

function sideStatus(transfer: SiteTransfer, side: Side): SideStatus {
  return side === 'station' ? transfer.stationStatus : transfer.fieldStatus
}

function sideReason(transfer: SiteTransfer, side: Side): string {
  return side === 'station' ? transfer.stationReason : transfer.fieldReason
}

const SIDE_NAME: Record<Side, string> = { station: '管理站', field: '外业队' }

/* ------------------------------- 建单 ------------------------------- */

function openCreate(): void {
  form.siteNo = ''
  form.fromReefId = ''
  form.toReefId = ''
  form.remark = ''
  dialogVisible.value = true
}

async function submitCreate(): Promise<void> {
  if (!form.siteNo.trim()) {
    ElMessage.warning('请填写要划转的站位编号（双方对账键）')
    return
  }
  if (!form.fromReefId || !form.toReefId) {
    ElMessage.warning('请选择划出礁区与划入礁区')
    return
  }
  if (form.fromReefId === form.toReefId) {
    ElMessage.warning('划出礁区与划入礁区不能相同')
    return
  }
  submitting.value = true
  try {
    const created = await transferStore.create({ ...form })
    ElMessage.success(`划转单已建：站位 ${created.siteNo}，请两侧分别对账`)
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof TransferRuleError ? error.message : '建单失败')
  } finally {
    submitting.value = false
  }
}

/* ------------------------------- 侧动作 ------------------------------- */

async function runSideAction(transfer: SiteTransfer, side: Side, action: SideAction): Promise<void> {
  const sideName = SIDE_NAME[side]
  try {
    if (action === 'apply') {
      await ElMessageBox.confirm(
        side === 'station'
          ? `确认执行【${sideName}侧】划转？将把站位 ${transfer.siteNo} 的 reefId 由原礁区划到相邻礁区；外业队数据不动。`
          : `确认执行【${sideName}侧】划转？该站位已有样带的归属礁区将随站位改到相邻礁区，白化结论起按新归属统计；管理站界线不动。`,
        `${sideName}侧划转确认`,
        { type: 'warning', confirmButtonText: '执行划转', cancelButtonText: '取消' }
      )
    } else if (action === 'withdraw') {
      await ElMessageBox.confirm(
        side === 'station'
          ? `确认只撤回【${sideName}侧】这一步？站位归属恢复原礁区；外业队那份照旧不变。`
          : `确认只撤回【${sideName}侧】这一步？样带归属恢复原礁区；管理站界线照旧不变。`,
        `${sideName}侧撤回确认`,
        { type: 'warning', confirmButtonText: '只撤回本侧', cancelButtonText: '取消' }
      )
    }
    const updated =
      action === 'reconcile'
        ? await transferStore.reconcile(transfer.id, side)
        : action === 'apply'
          ? await transferStore.apply(transfer.id, side)
          : await transferStore.withdraw(transfer.id, side)
    const status = sideStatus(updated, side)
    if (action === 'reconcile') {
      if (status === 'matched') ElMessage.success(`${sideName}侧按站位编号对账通过，可执行划转`)
      else ElMessage.warning(`${sideName}侧对不上，已挂起等人定：${sideReason(updated, side)}`)
    } else if (action === 'apply') {
      if (status === 'suspended') ElMessage.warning(`${sideName}侧划转前核对未通过，已挂起等人定：${sideReason(updated, side)}`)
      else ElMessage.success(`${sideName}侧划转完成`)
    } else {
      ElMessage.success(`${sideName}侧已撤回，另一侧照旧`)
    }
  } catch (error) {
    if (error === 'cancel' || (error as { message?: string })?.message === 'cancel') return
    ElMessage.error(error instanceof TransferRuleError ? error.message : `${sideName}侧操作失败`)
  }
}

/* ----------------------------- 挂起人工裁定 ----------------------------- */

const resolveDialog = reactive({
  visible: false,
  transferId: '' as string,
  side: 'station' as Side,
  loading: false,
  picked: '' as string,
  candidates: [] as Array<{ siteId: string; label: string; description: string; disabled: boolean }>
})

async function openResolve(transfer: SiteTransfer, side: Side): Promise<void> {
  resolveDialog.transferId = transfer.id
  resolveDialog.side = side
  resolveDialog.picked = ''
  resolveDialog.candidates = []
  resolveDialog.visible = true
  resolveDialog.loading = true
  try {
    if (side === 'station') {
      const list: Array<Site & { inFromReef: boolean }> = await transferStore.stationCandidates(transfer)
      resolveDialog.candidates = list.map((site) => ({
        siteId: site.id,
        label: `${site.no}（${site.id}）`,
        description: `当前归属：${reefStore.reefById(site.reefId)?.name ?? '未知礁区'}${site.inFromReef ? '' : '（不在划出礁区）'}`,
        disabled: false
      }))
    } else {
      const list: FieldSideSite[] = await transferStore.fieldCandidates(transfer)
      resolveDialog.candidates = list.map((site) => ({
        siteId: site.siteId,
        label: `${site.siteNo}（${site.siteId}）`,
        description: `外业归属：${reefStore.reefById(site.reefId)?.name ?? '未知礁区'} · ${site.beltCount} 条样带`,
        disabled: false
      }))
    }
  } finally {
    resolveDialog.loading = false
  }
}

async function submitResolve(): Promise<void> {
  if (!resolveDialog.picked) {
    ElMessage.warning('请先选定要人工裁定的站位')
    return
  }
  submitting.value = true
  try {
    await transferStore.resolve(resolveDialog.transferId, resolveDialog.side, resolveDialog.picked)
    ElMessage.success(`${SIDE_NAME[resolveDialog.side]}侧已人工裁定，状态转为已对账`)
    resolveDialog.visible = false
  } catch (error) {
    ElMessage.error(error instanceof TransferRuleError ? error.message : '人工裁定失败')
  } finally {
    submitting.value = false
  }
}

/* ------------------------------- 删除单据 ------------------------------- */

async function remove(transfer: SiteTransfer): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除站位 ${transfer.siteNo} 的划转单？仅删除单据记录，站位、样带与珊瑚覆盖数据都不会改动（已划转侧须先撤回）。`,
      '删除划转单',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await transferStore.remove(transfer.id)
    ElMessage.success('划转单已删除')
  } catch (error) {
    ElMessage.error(error instanceof TransferRuleError ? error.message : '删除失败')
  }
}

onMounted(() => {
  if (reefStore.reefs.length === 0) reefStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">站位划转台账</h2>
        <p class="gb-hint">
          保护区界线调整：管理站管界线与站位归属，外业队管样带布设与珊瑚覆盖。两侧按站位编号各自对账，
          对不上只挂起本侧等人定；划转后样带随站位换归属，白化结论不再把划走的样带算到原礁区。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建划转单</el-button>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="划转单" :value="stats.total" suffix="张" icon="ScaleToOriginal" />
      <StatBadge label="挂起待裁定" :value="stats.suspended" suffix="侧" tone="warning" icon="WarningFilled" />
      <StatBadge label="对账 / 划转中" :value="stats.pending" suffix="张" tone="info" icon="RefreshLeft" />
      <StatBadge label="划转完成" :value="stats.done" suffix="张" tone="success" icon="CircleCheckFilled" />
    </div>

    <EmptyPanel
      v-if="rows.length === 0"
      title="还没有划转单"
      description="界线调整后新建划转单：填写站位编号、划出与划入礁区，再由管理站与外业队两侧分别按站位编号对账。"
      action-text="新建划转单"
      @action="openCreate"
    />

    <el-card v-else shadow="never" class="gb-panel transfer-panel">
      <div v-for="row in rows" :key="row.transfer.id" class="transfer-card">
        <div class="transfer-card__head">
          <div class="transfer-card__title">
            <el-tag size="small" type="info" effect="plain" class="gb-mono">站位 {{ row.transfer.siteNo }}</el-tag>
            <span class="transfer-card__reef">
              <strong>{{ row.fromReefName }}</strong>
              <el-icon class="transfer-card__arrow"><Right /></el-icon>
              <strong>{{ row.toReefName }}</strong>
            </span>
            <TransferStatusTag :status="row.stage" kind="stage" />
          </div>
          <el-button size="small" type="danger" plain :icon="Delete" @click="remove(row.transfer)">删除单据</el-button>
        </div>
        <p v-if="row.transfer.remark" class="gb-hint transfer-card__remark">事由：{{ row.transfer.remark }}</p>

        <div class="transfer-sides">
          <div
            v-for="side in (['station', 'field'] as Side[])"
            :key="side"
            class="transfer-side"
            :class="{ 'is-suspended': sideStatus(row.transfer, side) === 'suspended' }"
          >
            <div class="transfer-side__head">
              <span class="transfer-side__name">{{ side === 'station' ? '保护区管理站侧（界线 / 站位归属）' : '外业队侧（样带 / 珊瑚覆盖）' }}</span>
              <TransferStatusTag :status="sideStatus(row.transfer, side)" />
            </div>
            <div class="transfer-side__body">
              <div class="transfer-side__line gb-mono">命中站位：{{ siteLabel(row.transfer, side) }}</div>
              <div v-if="sideReason(row.transfer, side)" class="gb-hint transfer-side__reason">
                {{ sideReason(row.transfer, side) }}
              </div>
              <div class="gb-hint gb-mono transfer-side__time">
                <template v-if="sideStatus(row.transfer, side) === 'applied'">
                  划转于 {{ formatTime(side === 'station' ? row.transfer.stationAppliedAt : row.transfer.fieldAppliedAt) }}
                </template>
                <template v-else-if="sideStatus(row.transfer, side) === 'withdrawn'">
                  撤回于 {{ formatTime(side === 'station' ? row.transfer.stationWithdrawnAt : row.transfer.fieldWithdrawnAt) }}
                </template>
                <template v-else-if="side === 'station' && row.transfer.stationMatchedAt">
                  对账于 {{ formatTime(row.transfer.stationMatchedAt) }}
                </template>
                <template v-else-if="side === 'field' && row.transfer.fieldMatchedAt">
                  对账于 {{ formatTime(row.transfer.fieldMatchedAt) }}
                </template>
              </div>
            </div>
            <div class="transfer-side__actions">
              <el-button
                v-if="['pending', 'suspended', 'withdrawn'].includes(sideStatus(row.transfer, side))"
                size="small"
                :type="sideStatus(row.transfer, side) === 'suspended' ? 'warning' : 'default'"
                @click="runSideAction(row.transfer, side, 'reconcile')"
              >
                按站位编号对账
              </el-button>
              <el-button
                v-if="sideStatus(row.transfer, side) === 'matched'"
                size="small"
                @click="runSideAction(row.transfer, side, 'reconcile')"
              >
                重新对账
              </el-button>
              <el-button
                v-if="sideStatus(row.transfer, side) === 'suspended'"
                size="small"
                type="warning"
                plain
                :icon="Select"
                @click="openResolve(row.transfer, side)"
              >
                人工指定
              </el-button>
              <el-button
                v-if="sideStatus(row.transfer, side) === 'matched'"
                size="small"
                type="primary"
                @click="runSideAction(row.transfer, side, 'apply')"
              >
                执行{{ side === 'station' ? '站位归属' : '样带归属' }}划转
              </el-button>
              <el-button
                v-if="sideStatus(row.transfer, side) === 'applied'"
                size="small"
                type="danger"
                plain
                :icon="RefreshLeft"
                @click="runSideAction(row.transfer, side, 'withdraw')"
              >
                只撤回本侧
              </el-button>
            </div>
          </div>
        </div>
      </div>
    </el-card>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="两侧各记各的，互不连带：管理站划转只改站点位；外业队划转只翻样带归属礁区。对不上的一侧挂起等人定，另一侧照常推进。任一侧撤回都只回滚自己这一步。"
    />

    <!-- 新建划转单 -->
    <el-dialog v-model="dialogVisible" title="新建站位划转单" width="520px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="站位编号" required>
          <el-input v-model="form.siteNo" placeholder="双方对账键，如 S-02" maxlength="24" />
        </el-form-item>
        <el-form-item label="划出礁区" required>
          <el-select v-model="form.fromReefId" class="page__full" placeholder="界线调整前所属礁区">
            <el-option v-for="opt in reefOptions" :key="`from-${opt.value}`" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="划入礁区" required>
          <el-select v-model="form.toReefId" class="page__full" placeholder="界线调整后的相邻礁区">
            <el-option v-for="opt in reefOptions" :key="`to-${opt.value}`" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="事由备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="如：核心区界线北扩，该站位划入相邻缓冲区" maxlength="120" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitCreate">建单（两侧初始待对账）</el-button>
      </template>
    </el-dialog>

    <!-- 挂起侧人工裁定 -->
    <el-dialog
      v-model="resolveDialog.visible"
      :title="`人工指定站位 · ${resolveDialog.side === 'station' ? '管理站侧' : '外业队侧'}`"
      width="560px"
      :close-on-click-modal="false"
    >
      <el-skeleton v-if="resolveDialog.loading" :rows="3" animated />
      <el-radio-group v-else v-model="resolveDialog.picked" class="resolve-group">
        <el-radio
          v-for="candidate in resolveDialog.candidates"
          :key="candidate.siteId"
          :value="candidate.siteId"
          class="resolve-option"
          :disabled="candidate.disabled"
        >
          <div class="resolve-option__text">
            <div class="gb-mono">{{ candidate.label }}</div>
            <div class="gb-hint">{{ candidate.description }}</div>
          </div>
        </el-radio>
        <EmptyPanel
          v-if="resolveDialog.candidates.length === 0"
          title="没有同编号站位"
          description="两侧台账中都查不到该站位编号，请核对编号或先在对应一侧补录后再裁定。"
          compact
        />
      </el-radio-group>
      <template #footer>
        <el-button @click="resolveDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitResolve">确认裁定（转已对账）</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__full {
  width: 100%;
}

.transfer-panel {
  padding: 8px 12px;
}

.transfer-card {
  padding: 14px 4px;
  border-bottom: 1px dashed var(--gb-line);
}

.transfer-card:last-child {
  border-bottom: none;
}

.transfer-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.transfer-card__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.transfer-card__reef {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: #10312f;
}

.transfer-card__arrow {
  color: #0b5d5a;
}

.transfer-card__remark {
  margin: 6px 0 0;
}

.transfer-sides {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 12px;
  margin-top: 10px;
}

.transfer-side {
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  padding: 10px 12px;
  background: #fbfdfd;
}

.transfer-side.is-suspended {
  border-color: #f5b7b1;
  background: #fef7f6;
}

.transfer-side__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.transfer-side__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--gb-teal);
}

.transfer-side__body {
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.transfer-side__line {
  font-size: 13px;
  color: #4c6663;
}

.transfer-side__reason {
  color: #c0392b;
}

.transfer-side__time {
  font-size: 12px;
}

.transfer-side__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.resolve-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}

.resolve-option {
  height: auto;
  align-items: flex-start;
  white-space: normal;
  padding: 8px 10px;
  border: 1px solid var(--gb-line);
  border-radius: 8px;
  margin-right: 0;
}

.resolve-option__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
