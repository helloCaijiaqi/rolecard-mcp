// rolecard-mcp 的 DSH persona 插件安装脚本（2026-11-20 独立化 + rootUrl 直连改造）。
//
// 把 dsh-plugin/ 物化为独立 DSH bundle 并完成注册：
//   ① ~/.dsh/plugins/<bundle> 真实目录（reuse 不删，幂等）
//   ② profile node_modules junction link + package.json 声明（link 依赖 + bundles 条目）
//
// ⚠️ entry 单一事实源 = bundle 自带的 patch.yml（dsh.bundle.patch 声明）。
// DSH 组装规则（packages/boot/app-boot/src/profile.ts）：bundles 清单顺序的各
// bundle patch 层 + cordis.patch.yml 用户层**全拼接、不去重**——同一 entry 写
// 两处会双实例化（waterfall 注册两次、人格 section 双份）。因此本脚本**绝不**
// 字面追加 cordis.patch.yml；若发现上一版遗留的追加 entry，自动清理。
//
// 物化/链接/manifest 语义复用 qq-bridge/scripts/lib/dsh-bundle.mjs 的已验证实现。
// 幂等：重复运行无副作用；完成后需重启 DSH 生效。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PROFILE,
  resolveProfileDir,
  planMaterializeDir,
  applyMaterializeDir,
  copyFileIfChanged,
  planDirLink,
  applyDirLink,
  readProfilePackage,
  patchProfilePackage,
  serializeProfilePackage,
} from '../../qq-bridge/scripts/lib/dsh-bundle.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sourceDir = path.resolve(here, '..', 'dsh-plugin')
const BUNDLE_NAME = 'rolecard-persona'
const PLUGIN_FILE = 'rolecard-persona.mjs'
// 上一版（qq- 前缀 + 字面追加 cordis.patch.yml）的遗留标识——脚本顺带清理。
const LEGACY_BUNDLE_NAME = 'qq-rolecard-persona'
const LEGACY_ENTRY_ID = 'qq-rolecard-persona'

const log = (msg) => console.log(`[install:dsh-plugin] ${msg}`)

function main() {
  const profile = process.argv[2] ?? DEFAULT_PROFILE
  const profileDir = resolveProfileDir(profile)
  log(`profile=${profile}（${profileDir}）`)

  // ① 物化 bundle 真实目录（reuse 语义：不删既有目录）。
  // 位置惯例：~/.dsh/plugins/<bundle>（profileDir 上两级），node_modules link
  // 与裸说明符解析都按此。
  const pluginsDir = path.join(profileDir, '..', '..', 'plugins', BUNDLE_NAME)
  const planned = planMaterializeDir(pluginsDir)
  applyMaterializeDir(planned, { log })
  let copied = 0
  for (const name of ['package.json', 'patch.yml', PLUGIN_FILE]) {
    const written = copyFileIfChanged(path.join(sourceDir, name), path.join(pluginsDir, name))
    if (written) copied += 1
  }
  log(`物化 ${pluginsDir}（${planned.action}，${copied} 个文件更新）`)

  // ② profile node_modules junction + package.json 声明
  const nodeModules = path.join(profileDir, 'node_modules')
  const linkPlanned = planDirLink(path.join(nodeModules, BUNDLE_NAME), pluginsDir, { requireTarget: false })
  const linkResult = applyDirLink(linkPlanned)
  log(`node_modules link：${linkResult.action}${linkResult.written ? '（已写）' : ''}`)

  const pkgPath = path.join(profileDir, 'package.json')
  const pkg = readProfilePackage(pkgPath)
  // patchProfilePackage 返回包装对象 { pkg, changed, dependency, bundleAdded }——
  // 落盘必须用 .pkg（裸 package.json 结构），linkDir 传绝对路径。
  const patched = patchProfilePackage(pkg, { name: BUNDLE_NAME, linkDir: pluginsDir })
  fs.writeFileSync(pkgPath, serializeProfilePackage(patched.pkg), 'utf8')
  log(`profile package.json 已声明 link 依赖（${patched.dependency}）与 bundles 条目`)

  // ③ 单一事实源守护：entry 只活在 bundle patch.yml；cordis.patch.yml 里绝不出现。
  //    清理上一版字面追加的遗留（含 qq- 前缀旧名）——**整块删除**（entry 行 +
  //    紧随的缩进行），只删 id 行会留孤儿 name/config 破坏 YAML。
  const patchPath = path.join(profileDir, 'cordis.patch.yml')
  if (fs.existsSync(patchPath)) {
    const lines = fs.readFileSync(patchPath, 'utf8').split(/\r?\n/)
    const legacyIds = [LEGACY_ENTRY_ID, BUNDLE_NAME]
    const dirty = legacyIds.some((id) => lines.some((l) => l.trim() === `- id: ${id}`))
    if (dirty) {
      fs.copyFileSync(patchPath, `${patchPath}.bak-persona-dedupe`)
      const cleaned = []
      let skipping = false
      for (const line of lines) {
        if (legacyIds.some((id) => line.trim() === `- id: ${id}`)) { skipping = true; continue }
        if (skipping) {
          // entry 块的附属行 = 缩进的 name/config 等（顶层行或空行终止块）
          if (/^\s+\S/.test(line)) continue
          skipping = false
        }
        cleaned.push(line)
      }
      fs.writeFileSync(patchPath, cleaned.join('\n'), 'utf8')
      log('已从 cordis.patch.yml 整块清理字面追加的遗留 entry（备份：.bak-persona-dedupe）')
    }
  }
  // 旧 qq- 前缀遗留全面清理（改名遗留）：物化目录 / junction / profile 注册条目。
  const legacyPluginsDir = path.join(profileDir, '..', '..', 'plugins', LEGACY_BUNDLE_NAME)
  if (fs.existsSync(legacyPluginsDir)) {
    fs.rmSync(legacyPluginsDir, { recursive: true, force: true })
    log(`已删除旧物化目录 ${legacyPluginsDir}`)
  }
  const legacyLink = path.join(nodeModules, LEGACY_BUNDLE_NAME)
  if (fs.existsSync(legacyLink)) {
    fs.rmSync(legacyLink, { recursive: true, force: true })
    log('已删除旧 node_modules junction')
  }
  {
    // 注意：readProfilePackage 返回**裸 package 对象**（patchProfilePackage 才包 {pkg}）。
    const current = readProfilePackage(pkgPath)
    let touched = false
    if (current.dependencies?.[LEGACY_BUNDLE_NAME] !== undefined) {
      delete current.dependencies[LEGACY_BUNDLE_NAME]
      touched = true
    }
    if (Array.isArray(current.dsh?.profile?.bundles)) {
      const before = current.dsh.profile.bundles.length
      current.dsh.profile.bundles = current.dsh.profile.bundles.filter((b) => b !== LEGACY_BUNDLE_NAME)
      if (current.dsh.profile.bundles.length !== before) touched = true
    }
    if (touched) {
      fs.writeFileSync(pkgPath, serializeProfilePackage(current), 'utf8')
      log('已清理 profile package.json 的旧 bundle 条目')
    }
  }

  log('完成。请重启 DSH 使插件生效（新会话开始注入角色卡人格）。')
}

main()
