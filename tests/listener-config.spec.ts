import { describe, expect, it } from 'vitest'
import {
  defaultRemoteHost,
  listenOptionsFor,
  loopbackFor,
  normalizeListenerHost,
  normalizeListenerPort,
  resolveListenerHost,
} from '../src/host/listener-config.ts'

describe('listener configuration', () => {
  it('accepts IPv4 and IPv6 bind addresses and chooses matching loopback', () => {
    expect(normalizeListenerHost(' 0.0.0.0 ')).toBe('0.0.0.0')
    expect(normalizeListenerHost('192.168.10.20')).toBe('192.168.10.20')
    expect(normalizeListenerHost('::')).toBe('::')
    expect(normalizeListenerHost('2001:db8::10')).toBe('2001:db8::10')
    expect(loopbackFor('0.0.0.0')).toBe('127.0.0.1')
    expect(loopbackFor('::', 'linux')).toBe('::1')
    expect(loopbackFor('::', 'darwin')).toBe('::1')
    // Windows 的回环固定 IPv4：只绑 `::1` 会让 `http://127.0.0.1:PORT` 全断。
    expect(loopbackFor('::', 'win32')).toBe('127.0.0.1')
    expect(loopbackFor('2001:db8::10', 'win32')).toBe('127.0.0.1')
  })

  it('rejects hostnames and ports outside the public listener range', () => {
    expect(() => normalizeListenerHost('workspace.example.com')).toThrowError(/numeric IPv4 or IPv6/)
    expect(() => normalizeListenerPort(0)).toThrowError(/between 1 and 65535/)
    expect(() => normalizeListenerPort(65_536)).toThrowError(/between 1 and 65535/)
    expect(normalizeListenerPort(30_90)).toBe(30_90)
  })
})

/**
 * issue #1 Bug 1：Windows 绑 `0.0.0.0` 是纯 IPv4 socket，接入面板据此把 IPv6 候选
 * 全部过滤掉。默认值必须按平台取，历史存下的 `0.0.0.0` 还要迁移成 `::`。
 */
describe('platform-aware listener host', () => {
  it('defaults to :: on Windows and 0.0.0.0 elsewhere', () => {
    expect(defaultRemoteHost('win32')).toBe('::')
    expect(defaultRemoteHost('linux')).toBe('0.0.0.0')
    expect(defaultRemoteHost('darwin')).toBe('0.0.0.0')
  })

  it('migrates a stored 0.0.0.0 to :: on Windows only', () => {
    expect(resolveListenerHost('0.0.0.0', 'win32')).toBe('::')
    expect(resolveListenerHost(' 0.0.0.0 ', 'win32')).toBe('::')
    expect(resolveListenerHost('0.0.0.0', 'linux')).toBe('0.0.0.0')
    // 具体地址与 `::` 原样保留；只有「全部网卡」这一种写法需要平台改写。
    expect(resolveListenerHost('192.168.10.20', 'win32')).toBe('192.168.10.20')
    expect(resolveListenerHost('::', 'win32')).toBe('::')
  })

  it('rejects non-IP input through the same validation', () => {
    expect(() => resolveListenerHost('workspace.example.com', 'win32')).toThrowError(/numeric IPv4 or IPv6/)
  })

  it('disables IPV6_V6ONLY when binding :: so both families are reachable', () => {
    expect(listenOptionsFor('::', 3090)).toEqual({ port: 3090, host: '::', ipv6Only: false })
    expect(listenOptionsFor('0.0.0.0', 3090)).toEqual({ port: 3090, host: '0.0.0.0' })
    expect(listenOptionsFor('::1', 3090)).toEqual({ port: 3090, host: '::1' })
  })
})
