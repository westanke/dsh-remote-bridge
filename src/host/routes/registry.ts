// 路由注册表：path → handler 一屏总览（issue #3）。
// 有序数组，first-match-wins；每个块内部的匹配顺序与其在原 dispatch 中的顺序一致。
// routes 只是文档性字面量（机读以 handler 内的分支为准），新增路由必须同步补一行。
import type { ApiRouteCtx, RouteCtx } from './shared.ts'
import { workspacesAndPresets, sessionsApi, sessionActions, schedulesAndSpeech } from './chat.ts'
import { manageCloudflare } from './cloudflare.ts'
import { deviceSelf, manageStatus, manageDevicesAndAccess } from './devices.ts'
import { rootsApi, attachmentsAndImage, uploadsApi, manageRoots, manageFiles } from './files.ts'
import { pluginRoutes } from './plugins.ts'
import { hostServiceProbe, providersAndNamespaces, providerItemRoutes } from './settings.ts'

export interface ApiRouteBlock {
  name: string
  routes: readonly string[]
  handler: (ctx: ApiRouteCtx) => Promise<boolean>
}

export interface ManageRouteBlock {
  name: string
  routes: readonly string[]
  handler: (ctx: RouteCtx) => Promise<boolean>
}

export const API_ROUTE_BLOCKS: readonly ApiRouteBlock[] = [
  { name: 'hostServiceProbe', routes: ['/api/v1/debug/host-services'], handler: hostServiceProbe },
  { name: 'deviceSelf', routes: ['/api/v1/devices/self'], handler: deviceSelf },
  { name: 'rootsApi', routes: ['/api/v1/roots', '/api/v1/roots/resolve', '/api/v1/trash'], handler: rootsApi },
  { name: 'workspacesAndPresets', routes: ['/api/v1/chat/workspaces', '/api/v1/chat/agent-presets', '/api/v1/chat/permission-presets'], handler: workspacesAndPresets },
  { name: 'providersAndNamespaces', routes: ['/api/v1/settings/providers', '/api/v1/settings/models', '/api/v1/settings/namespaces'], handler: providersAndNamespaces },
  { name: 'pluginRoutes', routes: ['/api/v1/settings/plugins'], handler: pluginRoutes },
  { name: 'providerItemRoutes', routes: ['?'], handler: providerItemRoutes },
  { name: 'sessionsApi', routes: ['/api/v1/chat/sessions'], handler: sessionsApi },
  { name: 'attachmentsAndImage', routes: ['/api/v1/image-handoff'], handler: attachmentsAndImage },
  { name: 'sessionActions', routes: ['?'], handler: sessionActions },
  { name: 'uploadsApi', routes: ['?'], handler: uploadsApi },
  { name: 'schedulesAndSpeech', routes: ['/api/v1/chat/schedules', '/api/v1/chat/speech/catalog', '/api/v1/chat/speech/transcriptions', '/api/v1/chat/speech/config'], handler: schedulesAndSpeech },
]

export const MANAGE_ROUTE_BLOCKS: readonly ManageRouteBlock[] = [
  { name: 'manageStatus', routes: ['/manage/status'], handler: manageStatus },
  { name: 'manageRoots', routes: ['/manage/roots'], handler: manageRoots },
  { name: 'manageDevicesAndAccess', routes: ['/manage/devices', '/manage/devices/prune', '/manage/pairings', '/manage/config/text', '/manage/remote/enable', '/manage/remote/disable', '/manage/remote/listener', '/manage/audit'], handler: manageDevicesAndAccess },
  { name: 'manageFiles', routes: ['/manage/image'], handler: manageFiles },
  { name: 'manageCloudflare', routes: ['/manage/cloudflare/status', '/manage/cloudflare/activity', '/manage/cloudflare/create', '/manage/cloudflare/stop'], handler: manageCloudflare },
]
