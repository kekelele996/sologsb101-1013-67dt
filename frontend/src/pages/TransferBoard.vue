<script setup lang="ts">
/**
 * 界线划转台 /transfers
 * 保护站调整界线，把站位从原礁区划到相邻礁区；样带跟着站位换归属。
 * - 两边各记各的账，一律按站位编号对账；
 * - 保护站划转出问题 / 撤回：只回滚保护站这一步，外业那份原样保留；
 * - 外业对不上：只在本侧把样带挂起，等人定，不自动改保护站账。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Back, RefreshLeft, Switch } from '@element-plus/icons-vue'
import AttribTag from '@/components/common/AttribTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { useTransferStore } from '@/stores/transferStore'
import { reefNameMap } from '@/utils/attribution'
import { RECON_ISSUE_LABELS, TRANSFER_STATUS_LABELS, TRANSFER_STEP_LABELS } from '@/types/transfer'
import type { ReefTransfer } from '@/types/transfer'
import { useAttribution } from '@/hooks/useAttribution'

const router = useRouter()
const reefStore = useReefStore()
const beltStore = useBeltStore()
const transferStore = useTransferStore()
const attribution = useAttribution()

const dialogVisible = ref(false)
const submitting = ref(false)
const selectedSiteIds = ref<string[]>([])
const form = reactive({
  toReefId: '',
  operator: '保护区管理站',
  remark: ''
})

const resolveVisible = ref(false)
const resolvingBeltId = ref<string | null>(null)
const resolveForm = reactive({ reefId: '', siteNo: '', reason: '' })

/** 展开的划转单 id 列表 */
const activeTransfers = ref<string[]>([])

const reefNames = computed(() => reefNameMap(reefStore.reefs))
function reefName(id: string): string {
  return reefNames.value.get(id) ?? '—'
}

/** 可发起划转的站位：附带当前礁区与样带数，排除已选中的 */
const selectableSites = computed(() =>
  reefStore.sites
    .map((site) => ({
      id: site.id,
      no: site.no,
      reefId: site.reefId,
      reefName: reefName(site.reefId),
      beltCount: beltStore.belts.filter((belt) => belt.siteId === site.id).length
    }))
    .sort((a, b) => a.no.localeCompare(b.no, 'zh-Hans-CN'))
)

/** 目标礁区选项（排除选中站位当前所在礁区） */
const targetReefOptions = computed(() => {
  const currentReefIds = new Set(
    reefStore.sites.filter((site) => selectedSiteIds.value.includes(site.id)).map((site) => site.reefId)
  )
  return reefStore.reefs.filter((reef) => !currentReefIds.has(reef.id))
})

const pendingRows = computed(() => attribution.pendingRows.value)
const reconRows = computed(() => attribution.rows.value)

function openCreate(): void {
  selectedSiteIds.value = []
  form.toReefId = ''
  form.remark = ''
  dialogVisible.value = true
}

async function submitTransfer(): Promise<void> {
  if (selectedSiteIds.value.length === 0) {
    ElMessage.warning('请先勾选要划转的站位')
    return
  }
  if (!form.toReefId) {
    ElMessage.warning('请选择划入的相邻礁区')
    return
  }
  submitting.value = true
  try {
    const result = await transferStore.createTransfer({
      operator: form.operator,
      remark: form.remark,
      items: selectedSiteIds.value.map((siteId) => ({ siteId, toReefId: form.toReefId }))
    })
    dialogVisible.value = false
    const failed = result.managerFailed.length
    const suspended = result.transfer.items.reduce((sum, item) => sum + item.suspendedBeltCount, 0)
    const moved = result.transfer.items.reduce((sum, item) => sum + item.movedBeltCount, 0)
    if (failed > 0) {
      ElMessage.warning(`保护站划转 ${failed} 个站位失败，已只回滚保护站这一步，外业数据未改动`)
    } else if (suspended > 0) {
      ElMessage.warning(`保护站划转完成；${moved} 条样带随站位移交，${suspended} 条对不上已在本侧挂起等人定`)
    } else {
      ElMessage.success(`划转完成：${moved} 条样带已随站位换归属`)
    }
  } finally {
    submitting.value = false
  }
}

async function handleRevert(transfer: ReefTransfer): Promise<void> {
  const applicable = transfer.items.filter((item) => item.managerStatus === 'applied')
  try {
    await ElMessageBox.confirm(
      `将只撤回保护站这一步：${applicable.length} 个站位的归属恢复到原礁区；外业队那份样带归属原样保留，差异进入对账挂起名单等人定。确认撤回？`,
      `撤回划转单 ${transfer.no}`,
      { type: 'warning', confirmButtonText: '只撤回保护站这一步', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await transferStore.revert(transfer.id)
  ElMessage.success('保护站划转已撤回，外业归属保持原样')
}

async function retryField(transfer: ReefTransfer, siteId: string): Promise<void> {
  await transferStore.retryField(transfer.id, siteId)
  ElMessage.success('已按当前保护站账重新对账外业侧')
}

function openResolve(beltId: string): void {
  resolvingBeltId.value = beltId
  const row = pendingRows.value.find((item) => item.beltId === beltId)
  const belt = beltStore.beltById(beltId)
  resolveForm.siteNo = row?.siteNo ?? belt?.attribSiteNo ?? ''
  resolveForm.reefId = row?.managerReefId || row?.fieldReefId || reefStore.reefs[0]?.id || ''
  resolveForm.reason = ''
  resolveVisible.value = true
}

async function submitResolve(): Promise<void> {
  if (!resolvingBeltId.value) return
  if (!resolveForm.reefId) {
    ElMessage.warning('请指定裁定后的归属礁区')
    return
  }
  if (!resolveForm.siteNo.trim()) {
    ElMessage.warning('请指定站位编号')
    return
  }
  await transferStore.resolveBelt(resolvingBeltId.value, {
    reefId: resolveForm.reefId,
    siteNo: resolveForm.siteNo.trim(),
    reason: resolveForm.reason.trim() || '人工核对站位编号后确认归属'
  })
  resolveVisible.value = false
  ElMessage.success('已解除挂起，样带按人工裁定重新计入礁区结论')
}

const stats = computed(() => ({
  transfers: transferStore.transfers.length,
  pendingBelts: pendingRows.value.length,
  appliedBelts: attribution.rows.value.filter((row) => row.matched).length,
  activeTransfers: transferStore.transfers.filter(
    (item) => item.status === 'pending' || item.status === 'partial'
  ).length
}))

onMounted(() => {
  transferStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">保护区界线划转 · 站位与样带归属对账</h2>
        <p class="gb-hint">
          保护站管界线、保护区状态与站位归属；外业队管样带布设与珊瑚覆盖。划转后样带跟着站位换归属，两边按站位编号对账，对不上的先挂起等人定。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Back" @click="router.push('/reefs')">返回礁区台账</el-button>
        <el-button type="primary" :icon="Switch" @click="openCreate">发起界线划转</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="划转单" :value="stats.transfers" suffix="张" icon="Files" />
      <StatBadge label="处理中划转" :value="stats.activeTransfers" suffix="张" tone="info" icon="DataLine" />
      <StatBadge label="归属已对齐样带" :value="stats.appliedBelts" suffix="条" tone="success" icon="CircleCheck" />
      <StatBadge
        label="挂起等人定"
        :value="stats.pendingBelts"
        suffix="条"
        :tone="stats.pendingBelts > 0 ? 'warning' : 'success'"
        icon="WarningFilled"
      />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>两账按站位编号对账（{{ reconRows.length }} 条样带）</h3>
        <span class="gb-hint">对得上才计入礁区白化结论；挂起/不一致的样带不计入任何礁区，等人定。</span>
      </div>

      <EmptyPanel
        v-if="reconRows.length === 0"
        title="还没有样带"
        description="请先在站位上布设样带；划转后两边将按站位编号在此对账。"
        compact
      />

      <el-table v-else :data="reconRows" border stripe class="gb-table-compact">
        <el-table-column label="样带 / 站位编号" min-width="180">
          <template #default="{ row }">
            <div class="gb-mono">样带 {{ row.beltNo }}</div>
            <div class="gb-hint">站位编号 {{ row.siteNo }}</div>
          </template>
        </el-table-column>
        <el-table-column label="保护站账归属" min-width="160">
          <template #default="{ row }">
            <span v-if="row.managerReefId">{{ reefName(row.managerReefId) }}</span>
            <span v-else class="gb-warn">查无 / 重号</span>
          </template>
        </el-table-column>
        <el-table-column label="外业账归属" min-width="160">
          <template #default="{ row }">
            <span v-if="row.fieldReefId">{{ reefName(row.fieldReefId) }}</span>
            <span v-else class="gb-warn">未建账</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <AttribTag :status="row.effectiveReefId ? 'active' : 'suspended'" :reason="row.detail" size="small" />
          </template>
        </el-table-column>
        <el-table-column label="对账说明" min-width="240">
          <template #default="{ row }">
            <span :class="row.matched ? 'gb-hint' : 'gb-warn'">{{ row.detail }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button v-if="!row.matched" link type="primary" size="small" @click="openResolve(row.beltId)">
              人工裁定
            </el-button>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>挂起样带（外业侧本侧挂起，等人定）</h3>
        <span class="gb-hint">保护站划转撤回或编号对不上都会产生挂起；裁定后即重新计入对应礁区。</span>
      </div>
      <el-table :data="pendingRows" border stripe class="gb-table-compact">
        <el-table-column label="样带" min-width="140">
          <template #default="{ row }">
            <div class="gb-mono">{{ row.beltNo }}</div>
            <div class="gb-hint">{{ row.siteNo }}</div>
          </template>
        </el-table-column>
        <el-table-column label="差异类型" width="170">
          <template #default="{ row }">
            <el-tag v-if="row.issue" type="warning" size="small">
              {{ RECON_ISSUE_LABELS[row.issue as keyof typeof RECON_ISSUE_LABELS] }}
            </el-tag>
            <span v-else class="gb-hint">归属不一致</span>
          </template>
        </el-table-column>
        <el-table-column label="原因" min-width="260">
          <template #default="{ row }">
            <span class="gb-warn">{{ row.detail }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openResolve(row.beltId)">人工裁定</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>划转单记录</h3>
        <span class="gb-hint">保护站划转与外业划转分两步记录，撤回只动保护站这一步。</span>
      </div>
      <EmptyPanel
        v-if="transferStore.transfers.length === 0"
        title="尚未发起界线划转"
        description="点右上角「发起界线划转」，选择要从原礁区划到相邻礁区的站位。"
        compact
      />
      <el-collapse v-else v-model="activeTransfers">
        <el-collapse-item v-for="transfer in transferStore.transfers" :key="transfer.id" :name="transfer.id">
          <template #title>
            <div class="transfer-title">
              <span class="gb-mono">{{ transfer.no }}</span>
              <el-tag size="small" :type="transfer.status === 'applied' ? 'success' : 'warning'">
                {{ TRANSFER_STATUS_LABELS[transfer.status] }}
              </el-tag>
              <span class="gb-hint">{{ transfer.operator }} · {{ new Date(transfer.createdAt).toLocaleString('zh-CN') }}</span>
            </div>
          </template>

          <div class="transfer-meta gb-hint" v-if="transfer.remark">备注：{{ transfer.remark }}</div>

          <el-table :data="transfer.items" border size="small" class="gb-table-compact">
            <el-table-column label="站位编号" prop="siteNo" width="110" />
            <el-table-column label="原礁区" min-width="150">
              <template #default="{ row }">{{ reefName(row.fromReefId) }}</template>
            </el-table-column>
            <el-table-column label="划入礁区" min-width="150">
              <template #default="{ row }">{{ reefName(row.toReefId) }}</template>
            </el-table-column>
            <el-table-column label="保护站侧" width="110">
              <template #default="{ row }">
                <el-tag size="small" :type="row.managerStatus === 'applied' ? 'success' : row.managerStatus === 'reverted' ? 'info' : 'danger'">
                  {{ TRANSFER_STEP_LABELS[row.managerStatus as keyof typeof TRANSFER_STEP_LABELS] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="外业侧" min-width="220">
              <template #default="{ row }">
                <el-tag size="small" :type="row.fieldStatus === 'applied' ? 'success' : row.fieldStatus === 'failed' ? 'warning' : 'info'">
                  {{ TRANSFER_STEP_LABELS[row.fieldStatus as keyof typeof TRANSFER_STEP_LABELS] }}
                </el-tag>
                <span class="gb-hint gb-ml8">{{ row.note }}</span>
              </template>
            </el-table-column>
            <el-table-column label="外业操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.managerStatus === 'applied' && row.fieldStatus !== 'applied'"
                  link
                  type="primary"
                  size="small"
                  @click="retryField(transfer, row.siteId)"
                >
                  重跑外业对账
                </el-button>
                <span v-else class="gb-hint">—</span>
              </template>
            </el-table-column>
          </el-table>

          <div class="transfer-actions">
            <el-button
              size="small"
              :icon="RefreshLeft"
              :disabled="!transfer.items.some((item) => item.managerStatus === 'applied')"
              @click="handleRevert(transfer)"
            >
              只撤回保护站这一步
            </el-button>
          </div>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <!-- 发起划转 -->
    <el-dialog v-model="dialogVisible" title="发起保护区界线划转" width="720px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="划转先改保护站站位归属；成功后外业按站位编号把样带移交新礁区。保护站这一步失败只回滚这一步；外业对不上的样带只在本侧挂起。"
        class="gb-mb12"
      />
      <el-form label-width="110px">
        <el-form-item label="划转站位">
          <el-select
            v-model="selectedSiteIds"
            multiple
            collapse-tags
            collapse-tags-tooltip
            placeholder="按站位编号勾选要划走的站位"
            style="width: 100%"
          >
            <el-option
              v-for="site in selectableSites"
              :key="site.id"
              :value="site.id"
              :label="`站位 ${site.no}（${site.reefName}，${site.beltCount} 条样带）`"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="划入相邻礁区">
          <el-select v-model="form.toReefId" placeholder="选择相邻礁区" style="width: 100%">
            <el-option v-for="reef in targetReefOptions" :key="reef.id" :value="reef.id" :label="reef.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="发起单位">
          <el-input v-model="form.operator" placeholder="保护区管理站" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="界线调整依据、文号等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitTransfer">执行划转</el-button>
      </template>
    </el-dialog>

    <!-- 人工裁定挂起样带 -->
    <el-dialog v-model="resolveVisible" title="人工裁定挂起样带归属" width="560px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="仅改外业队本侧归属账，保护站账不自动改；裁定后若与保护站账按站位编号一致，即重新计入礁区结论。"
        class="gb-mb12"
      />
      <el-form label-width="110px">
        <el-form-item label="站位编号">
          <el-input v-model="resolveForm.siteNo" placeholder="如 S-02" />
        </el-form-item>
        <el-form-item label="归属礁区">
          <el-select v-model="resolveForm.reefId" style="width: 100%">
            <el-option v-for="reef in reefStore.reefs" :key="reef.id" :value="reef.id" :label="reef.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="裁定依据">
          <el-input v-model="resolveForm.reason" type="textarea" :rows="2" placeholder="人工核对结论" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="resolveVisible = false">取消</el-button>
        <el-button type="primary" @click="submitResolve">确认解除挂起</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<script lang="ts">
export default { name: 'TransferBoard' }
</script>

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

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.transfer-title {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.transfer-meta {
  margin: 4px 0 8px;
}

.transfer-actions {
  margin-top: 10px;
}

.gb-ml8 {
  margin-left: 8px;
}

.gb-mb12 {
  margin-bottom: 12px;
}

.gb-warn {
  color: #9a6700;
}
</style>
