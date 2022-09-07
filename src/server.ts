import GlobalState from '@/globalState'
import KcpServer from '@/kcpServer'
import { waitMs } from '@/utils/asyncWait'
import WebServer from '@/webServer'
import { mkdirSync, statSync } from 'fs'
import * as hostile from 'hostile'
import { join } from 'path'
import { PerformanceObserver } from 'perf_hooks'
import { argv, cwd, execPath, exit } from 'process'
import config, { SUPPORT_REGIONS, SUPPORT_VERSIONS } from './config'
import DnsServer from './dnsServer'
import Logger from './logger'
import { cRGB } from './tty'
import { Announcement } from './types/announcement'
import Update from './update'
import Authenticator from './utils/authenticator'
import { detachedSpawn, execCommand } from './utils/childProcess'

const {
  version,
  serverName,
  dispatchRegion,
  dispatchSeed,
  dispatchKeyId,
  autoPatch,
  httpPort,
  httpsPort,
  recorderPort,
  hosts
} = config

const requiredDirs = [
  // game resource
  'data/bin/' + version,
  'data/proto/' + version,
  'data/game/' + version,

  // RSA key
  'data/key',

  // log
  'data/log/server',
  'data/log/client',
  'data/log/dump',

  // user data
  'data/user',

  // windy
  'data/luac'
]

// dispatch RSA key
if (dispatchKeyId) requiredDirs.push('data/key/' + dispatchKeyId)

const welcomeAnnouncement: Announcement = {
  type: 2, // Game
  subtitle: 'Welcome',
  title: `Welcome to ${serverName}!`,
  banner: 'https://webstatic-sea.mihoyo.com/hk4e/announcement/img/banner/welcome.png',
  content: '<p style="white-space: pre-wrap;">Hello, have fun~~</p><img src="https://webstatic-sea.mihoyo.com/hk4e/announcement/img/fallen.png"><p style="white-space: pre-wrap;">Powered by: HuTao GS</p>',
  start: Date.now(),
  end: Date.now() + (365 * 24 * 60 * 60e3),
  tag: 3,
  loginAlert: true
}

const logger = new Logger('SERVER')

export default class Server {
  globalState: GlobalState

  observer: PerformanceObserver

  update: Update
  auth: Authenticator

  dnsServer: DnsServer
  webServer: WebServer
  kcpServer: KcpServer

  readyToStart: boolean

  constructor() {
    // Window title
    logger.write(`\x1b]0;${serverName}\x07`)

    // Start log capture
    Logger.startCapture()

    // Server build info
    logger.info(`Name: ${cRGB(0xffffff, serverName)}`)
    logger.info(`Build: ${cRGB(0xffffff, process.env.BUILD_INFO || 'development')}`)
    logger.info(`Game version: ${cRGB(0xffffff, version)}`)
    logger.info(`Dispatch region: ${cRGB(0xffffff, dispatchRegion)}`)
    logger.info(`Dispatch seed: ${cRGB(0xffffff, dispatchSeed)}`)
    logger.info(`Dispatch key: ${cRGB(0xffffff, dispatchKeyId?.toString())}`)
    logger.info(`Auto patch: ${cRGB(0xffffff, autoPatch.toString())}`)
    logger.info(`Log level: ${cRGB(0xffffff, logger.getLogLevel().toString())}`)

    if (!SUPPORT_REGIONS.includes(dispatchRegion)) {
      logger.error('Unsupported region.')
      return
    }

    if (!SUPPORT_VERSIONS.includes(version)) {
      logger.error('Unsupported version.')
      return
    }

    this.checkDirs()

    this.globalState = new GlobalState()
    this.globalState.load()

    this.observer = new PerformanceObserver(list => logger.performance(list))

    this.update = new Update(this)
    this.auth = new Authenticator('data/auth.json')

    this.dnsServer = new DnsServer(this)
    this.webServer = new WebServer(this)
    this.kcpServer = new KcpServer(this)

    this.webServer.announcements.push(welcomeAnnouncement)

    this.readyToStart = true
  }

  get announcements() {
    return this.webServer.announcements
  }

  getGState(key: string) {
    return this.globalState.get(key)
  }

  async flushDNS(): Promise<void> {
    await execCommand('ipconfig /flushdns')
  }

  async setHosts(): Promise<void> {
    if (!hosts) return

    logger.debug('Setting hosts...')

    for (const host of hosts) {
      for (let i = 1; i <= 10; i++) {
        try {
          hostile.set('127.0.0.1', host)
          break
        } catch (err) {
          // only throw error if all attempts failed
          if (i >= 10) {
            logger.error('Set hosts failed:', err)
            this.restart(15e3)
            return
          }
        }
      }
    }

    logger.debug('Set hosts success.')

    logger.debug('Flushing dns...')
    try {
      await this.flushDNS()
      logger.debug('Flush dns success.')
    } catch (err) {
      logger.error('Flush dns failed:', err)
      this.restart(15e3)
    }
  }

  async removeHosts(): Promise<void> {
    if (!hosts) return

    logger.debug('Removing hosts...')

    for (const host of hosts) {
      for (let i = 1; i <= 10; i++) {
        try {
          hostile.remove('127.0.0.1', host)
          break
        } catch (err) {
          // only throw error if all attempts failed
          if (i >= 10) {
            logger.error('Remove hosts failed:', err)
            this.restart(15e3)
            return
          }
        }
      }
    }

    logger.debug('Remove hosts success.')

    logger.debug('Flushing dns...')
    try {
      await this.flushDNS()
      logger.debug('Flush dns success.')
    } catch (err) {
      logger.error('Flush dns failed:', err)
      this.restart(15e3)
    }
  }

  async start(): Promise<void> {
    const { observer, dnsServer, webServer, kcpServer, readyToStart } = this
    if (!readyToStart) return

    observer.observe({ entryTypes: ['measure'], buffered: true })

    Logger.mark('Start')

    logger.info('Starting...')

    await this.setHosts()

    let listening = 0

    async function onListening(): Promise<void> {
      if (++listening < 3) return

      logger.info('Started.')
      Logger.measure('Server start', 'Start')
    }

    dnsServer.on('listening', onListening)
    webServer.on('listening', onListening)
    kcpServer.on('listening', onListening)

    try {
      dnsServer.start()
      webServer.start([
        { port: httpPort },
        { port: httpsPort, useHttps: true },
        { port: recorderPort }
      ])
      kcpServer.start()
    } catch (err) {
      logger.error('Error while starting:', err)
    }
  }

  async restart(delay: number = 1e3): Promise<void> {
    logger.info('Restarting...', `Delay: ${delay}ms`)

    await this.runShutdownTasks()
    await waitMs(delay)

    await detachedSpawn(execPath, argv.slice(1))
    exit()
  }

  async stop(delay: number = 1e3): Promise<void> {
    logger.info('Stopping...', `Delay: ${delay}ms`)

    await this.runShutdownTasks(true)
    await waitMs(delay)

    exit()
  }

  async runShutdownTasks(fullShutdown: boolean = false) {
    const { globalState, observer, dnsServer, webServer, kcpServer, readyToStart } = this
    if (!readyToStart) return // Can't shutdown if it never started in the first place...

    await kcpServer.stop()

    webServer.stop()
    dnsServer.stop()

    globalState.save()

    if (fullShutdown) {
      await this.removeHosts()
    }

    observer.disconnect()

    await Logger.stopCapture(!!globalState.get('SaveLog'))
  }

  setLogLevel(level: number) {
    logger.setLogLevel(level)
  }

  checkDirs() {
    for (const path of requiredDirs) {
      try { if (statSync(join(cwd(), path))) continue } catch (err) { }
      try {
        logger.info('Creating directory:', path)
        mkdirSync(join(cwd(), path), { recursive: true })
      } catch (err) {
        logger.error(err)
      }
    }
  }
}