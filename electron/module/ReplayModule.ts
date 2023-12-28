import { ipcMain, /* dialog, app, */ MenuItem, Menu, globalShortcut } from 'electron';
import { join } from "path";
import { readFileSync } from "fs";
/* import { writeFile } from "fs/promises"; */
import { Sender } from '../helper/Sender';
import { Action } from '../../types/Action';
import { Server } from '../connector/Server';
import fetch, { FetchError } from 'electron-fetch'
import { Agent } from "https";
import type { DisplayError } from '../../types/DisplayError';
import { store } from '../index'
import { keyboard } from '@nut-tree/nut-js'
import { Key } from '@nut-tree/nut-js/dist/lib/key.enum';
import api from '../api';
import log from 'electron-log';

const cert = readFileSync(join(__dirname, '..', '..', 'riotgames.pem'))

const httpsAgent = new Agent({
  ca: cert
});

export class ReplayModule {
  static replayUrl = "https://127.0.0.1:2999/replay/"
  private playbackInterval?: NodeJS.Timeout
  private renderInterval?: NodeJS.Timeout
  private subMenu: Electron.MenuItem | null
  private menuItem: Electron.MenuItem
  private logger: log.LogFunctions
  private playbackData?: {
    savedAt: number
    time: number
  }
  //private renderData: any = {}
  public actions: [string, Action][] = [
    ["sync-replay", {
      title: "Sync to first Operator",
      type: 'button'
    }],
    ["sync-replay-plus-5", {
      title: "Sync to first Operator (+5 sec)",
      type: 'button'
    }],
    ["sync-replay-plus-10", {
      title: "Sync to first Operator (+10 sec)",
      type: 'button'
    }],
    ["sync-replay-input", {
      title: "Sync to first Operator (+/- Time)",
      type: 'input',
      input: {
        type: 'number',
        default: -5
      }
    }],
    ["jump-to-time", {
      title: "Jump to a In-Game Time",
      type: 'input',
      input: {
        type: 'text',
        default: '00:00',
        pattern: /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/
      }
    }],
    ["cinematic-ui", {
      title: "Set up UI for cinematic",
      type: 'button'
    }],
    ["obs-ui", {
      title: "Set up UI for Observing",
      type: 'button'
    }]
  ]
  private syncMode: boolean
  public isSynced = false
  private interfaceState = {
    'interfaceAll': true,
    'healthBarChampions': true,
    'healthBarMinions': true,
    'healthBarStructures': true,
    'interfaceScoreboard': true,
    'healthBarWards': true,
    'interfaceNeutralTimers': true,
    'interfaceChat': false,
    'interfaceKillCallouts': false,
    'interfaceTimeline': false,
  }

  constructor(
    public id: string,
    public name: string,
    public namespace: string,
    public type: string,
    private server: Server,
    private menu: Menu,
  ) {
    this.logger = log.scope(id)

    ipcMain.handle(`${id}-start`, () => {
      this.connect()
    })
    ipcMain.handle(`${id}-stop`, () => {
      this.disconnect()
    })
    /* ipcMain.handle(`${id}-save`, () => {
      this.saveData()
    }) */
    ipcMain.handle(`${id}-sync-replay`, () => {
      this.syncReplay()
    })
    ipcMain.handle(`${id}-sync-replay-plus-5`, () => {
      this.syncReplay(5)
    })
    ipcMain.handle(`${id}-sync-replay-plus-10`, () => {
      this.syncReplay(10)
    })
    ipcMain.handle(`${id}-sync-replay-input`, (_e, value) => {
      this.syncReplay(value)
    })
    ipcMain.handle(`${id}-jump-to-time`, (_e, value) => {
      this.jumpToTime(value)
    })
    ipcMain.handle(`${id}-cinematic-ui`, () => {
      this.cinematicUI()
    })
    ipcMain.handle(`${id}-obs-ui`, () => {
      this.obsUI()
    })

    api.get('/replay_sync', (req, res) => {
      const time = parseInt(req.query.seconds as string ?? 0)
      this.syncReplay(time)
      res.send().status(200)
    })
    api.get('/replay_time', (req, res) => {
      const time = req.query.time as string
      this.jumpToTime(time)
      res.send().status(200)
    })
    api.get('/ui_obs', (_req, res) => {
      this.obsUI()
      res.send().status(200)
    })
    api.get('/ui_cinematic', (_req, res) => {
      this.cinematicUI()
      res.send().status(200)
    })

    this.syncMode = store.get("replay-send-information")

    store.onDidChange('replay-send-information', (newValue, oldValue) => {
      if (oldValue === undefined || oldValue === newValue || newValue === undefined) return

      this.syncMode = newValue

      if (this.menuItem.checked) {
        this.disconnect()
        this.connect()
      }
    })

    this.subMenu = this.menu.getMenuItemById('tools')
    this.menuItem = new MenuItem({
      label: this.name,
      submenu: [
        {
          id: this.id,
          label: this.name,
          type: 'checkbox',
          checked: false,
          click: (e) => {
            if (e.checked) {
              this.connect()
            } else {
              this.disconnect()
            }
          }
        },
        {
          type: "separator"
        },
        {
          id: this.id + "_send_playback",
          label: "Send Information",
          type: "radio",
          checked: this.syncMode,
          click: () => {
            this.sendPlayback()
            store.set("replay-send-information", true)
          }
        },
        {
          id: this.id + "_get_playback",
          label: "Get Information",
          type: "radio",
          checked: !this.syncMode,
          click: () => {
            this.getPlayback()
            store.set("replay-send-information", false)
          }
        },
        {
          type: "separator"
        },
        {
          type: 'normal',
          label: 'Sync to first Operator',
          accelerator: 'Ctrl+J',
          click: () => {
            this.syncReplay()
          }
        },
        {
          type: 'normal',
          label: 'Sync to first Operator (+5 sec)',
          accelerator: 'Ctrl+K',
          click: () => {
            this.syncReplay(5)
          }
        },
        {
          type: 'normal',
          label: 'Sync to first Operator (+10 sec)',
          accelerator: 'Ctrl+L',
          click: () => {
            this.syncReplay(10)
          }
        }
      ]
    })

    this.subMenu?.submenu?.append(this.menuItem)

    this.server.onConnected(() => {
      if (!this.isSynced) return
      if (!this.syncMode) {
        setTimeout(() => {
          this.getPlayback()
        }, 0)
      } else if (this.syncMode) {
        setTimeout(() => {
          this.sendPlayback()
        }, 0)
      }
    })
  }

  public connect(): void {
    if (!this.server.isConnected) {
      if (this.menuItem.submenu) {
        this.menuItem.submenu.items[0].checked = false
      }
      return
    }

    Sender.emit(this.id, 1)

    if (this.menuItem.submenu) {
      this.menuItem.submenu.items[0].checked = true
    }

    if (!this.syncMode) {
      setTimeout(() => {
        this.getPlayback()
      }, 0)
    } else if (this.syncMode) {
      setTimeout(() => {
        this.sendPlayback()
      }, 0)
      this.server.subscribe('module-league-caster-cockpit', 'show-gold', () => {
        keyboard.type(Key.X)
      })
    }

    globalShortcut.register('CommandOrControl+J', () => {
      this.syncReplay()
    })
    globalShortcut.register('CommandOrControl+K', () => {
      this.syncReplay(5)
    })
    globalShortcut.register('CommandOrControl+L', () => {
      this.syncReplay(10)
    })
  }

  private sendPlayback() {
    if (!this.menuItem.submenu?.items[2].checked) return

    this.server.unsubscribe(this.namespace, this.type)
    this.playbackInterval = setInterval(() => {
      this.handleSandingPlayback()
    }, 5000)
    this.handleSandingPlayback()
  }

  private async handleSandingPlayback() {
    const fetchUri = ReplayModule.replayUrl + "playback"
    const fetchUriRender = ReplayModule.replayUrl + "render"

    try {
      const res = await fetch(fetchUri, {
        agent: httpsAgent,
        useElectronNet: false
      })
      const resRender = await fetch(fetchUriRender, {
        agent: httpsAgent,
        useElectronNet: false
      })

      if (!res.ok || !resRender.ok) return

      const json = await res.json()
      const jsonRender = await resRender.json()
      const savedAt = new Date().getTime() + this.server.prodTimeOffset
      const time = Math.round(json.time)
      const newData = {
        savedAt,
        time
      }

      this.playbackData = newData
      this.server.send({
        meta: {
          namespace: this.namespace,
          type: "set-playback",
          version: 1
        },
        savedAt,
        time,
        data: jsonRender
      })

      this.isSynced = true
      Sender.emit(this.id, 2)
    } catch (e) {
      if ((e as FetchError).code && (e as FetchError).code === "ECONNREFUSED") {
        Sender.emit(this.id, 1)
      } else {
        this.disconnect()

        this.logger.error(e)
        Sender.emit('error', {
          color: "error",
          title: 'Error while fetching data from game',
          message: (e as Error).message
        } as DisplayError)
      }
    }
  }

  private syncReplay(delay = 0) {
    if (!this.playbackData) return

    try {
      const diff = Math.round(((new Date().getTime() + this.server.prodTimeOffset) - this.playbackData.savedAt) / 1000)
      const time = this.playbackData.time + diff + delay

      const uri = ReplayModule.replayUrl + "playback"
      fetch(uri, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          time: time >= 0 ? time : 0
        }),
        redirect: 'follow',
        agent: httpsAgent,
        useElectronNet: false
      })
    } catch (e) {
      if ((e as FetchError).code && (e as FetchError).code === "ECONNREFUSED") {
        Sender.emit(this.id, 1)
      } else {
        this.disconnect()

        this.logger.error(e)
        Sender.emit('error', {
          color: "error",
          title: 'Error while sending data to game',
          message: (e as Error).message
        } as DisplayError)
      }
    }
  }

  private jumpToTime(time: string) {
    if (!this.playbackData) return

    try {
      const a = time.split(':')
      const seconds = (+a[0]) * 60 + (+a[1])

      const uri = ReplayModule.replayUrl + "playback"
      fetch(uri, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          time: seconds
        }),
        redirect: 'follow',
        agent: httpsAgent,
        useElectronNet: false
      })
    } catch (e) {
      if ((e as FetchError).code && (e as FetchError).code === "ECONNREFUSED") {
        Sender.emit(this.id, 1)
      } else {
        this.disconnect()

        this.logger.error(e)
        Sender.emit('error', {
          color: "error",
          title: 'Error while sending data to game',
          message: (e as Error).message
        } as DisplayError)
      }
    }
  }

  cinematicUI(): void {
    if (!this.playbackData) return

    const uri = ReplayModule.replayUrl + "render"

    const setup = this.interfaceState
    setup.interfaceChat = false
    setup.interfaceAll = false
    setup.healthBarChampions = false
    setup.healthBarMinions = false
    setup.healthBarStructures = false
    setup.healthBarWards = false

    try {
      fetch(uri, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(setup),
        redirect: 'follow',
        agent: httpsAgent,
        useElectronNet: false
      })
    } catch (e) {
      if ((e as FetchError).code && (e as FetchError).code === "ECONNREFUSED") {
        Sender.emit(this.id, 1)
      } else {
        this.disconnect()

        this.logger.error(e)
        Sender.emit('error', {
          color: "error",
          title: 'Error while sending data to game',
          message: (e as Error).message
        } as DisplayError)
      }
    }
  }

  obsUI(): void {
    if (!this.playbackData) return

    const uri = ReplayModule.replayUrl + "render"

    const setup = this.interfaceState
    setup.interfaceChat = false
    setup.interfaceAll = true
    setup.healthBarChampions = true
    setup.healthBarMinions = true
    setup.healthBarStructures = true
    setup.healthBarWards = true
    setup.interfaceNeutralTimers = true
    setup.interfaceKillCallouts = false
    setup.interfaceTimeline = false
    setup.interfaceScoreboard = true

    try {
      fetch(uri, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(setup),
        redirect: 'follow',
        agent: httpsAgent,
        useElectronNet: false
      })
    } catch (e) {
      if ((e as FetchError).code && (e as FetchError).code === "ECONNREFUSED") {
        Sender.emit(this.id, 1)
      } else {
        this.disconnect()

        this.logger.error(e)
        Sender.emit('error', {
          color: "error",
          title: 'Error while sending data to game',
          message: (e as Error).message
        } as DisplayError)
      }
    }
  }

  private getPlayback() {
    if (!this.menuItem.submenu?.items[3].checked) return

    if (this.playbackInterval) {
      clearInterval(this.playbackInterval)
    }

    this.server.subscribe(this.namespace, this.type, (data) => {
      this.playbackData = {
        savedAt: data.savedAt,
        time: data.time
      }
    })

    this.isSynced = true
    Sender.emit(this.id, 2)
  }

  public disconnect(): void {
    this.server.unsubscribe(this.namespace, this.type)
    if (this.playbackInterval) {
      clearInterval(this.playbackInterval)
    }
    if (this.renderInterval) {
      clearInterval(this.renderInterval)
    }

    this.isSynced = false
    Sender.emit(this.id, 0)

    if (this.menuItem.submenu) {
      this.menuItem.submenu.items[0].checked = false
    }

    this.server.unsubscribe('module-league-caster-cockpit', 'show-gold')

    globalShortcut.unregister('CommandOrControl+J')
    globalShortcut.unregister('CommandOrControl+K')
    globalShortcut.unregister('CommandOrControl+L')
  }

  /* private async saveData() {
    const saveDialog = await dialog.showSaveDialog({
      title: 'Select the File Path to save',
      defaultPath: join(app.getPath('documents'), `../Observer Tool/${this.name}-data.json`),
      buttonLabel: 'Save',
      filters: [
        {
          name: 'Text Files',
          extensions: ['json']
        },
      ],
      properties: []
    })

    if (!saveDialog.canceled && saveDialog.filePath) {
      const saveData = JSON.stringify({
        playback: this.playbackData,
        render: this.renderData
      }, null, 2)
      const savePath = saveDialog.filePath.toString()
      await writeFile(savePath, saveData)
    }
  } */
}