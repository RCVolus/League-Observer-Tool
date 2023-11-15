import { ipcMain, dialog, /* app, */ MenuItem, type Menu } from 'electron';
/* import { join } from "path";
import { writeFile } from "fs/promises"; */
import { Sender } from '../helper/Sender';
import type { Server } from '../connector/Server';
import type { LPTEvent } from '../../types/LPTE'
import type { LCU } from '../connector/LCU'
import type { DisplayError } from '../../types/DisplayError';
import { connectToLeague, disconnectFromLeague, isReady, makeSnapshot, setVersion } from "@floh22/farsight";
import log from 'electron-log';
import { Action } from '../../types/Action';

export class Farsight {
  //private data: Array<any> = []
  public actions: [string, Action][] = []
  private interval?: NodeJS.Timeout
  private subMenu: MenuItem | null
  private menuItem: MenuItem
  private isSynced = false
  private isConnected = false
  private logger: log.LogFunctions

  constructor(
    public id: string,
    public name: string,
    public namespace: string,
    protected lcu: LCU,
    private server: Server,
    private menu: Menu
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

    this.subMenu = this.menu.getMenuItemById('tools')
    this.menuItem = new MenuItem({
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
    })
    this.subMenu?.submenu?.append(this.menuItem)

    this.server.onConnected(() => {
      if (!this.isSynced) return
      this.getData()
    })
  }

  /**
   * Gets information about the live-game if available and sets the interval
   * to get live game information
   * if live-game is not available, sends and error to the frontend 
  */
  public async connect(): Promise<void> {
    if (!this.server.isConnected) {
      if (this.menuItem) {
        this.menuItem.checked = false
      }
      return
    }

    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Accept", "Cancel"],
      title: "Memory Reading Warning",
      message: "Farsight uses Memory Reading to get information that the Riot API does not expose. Riot's policy in the past has been to allow passive memory reading, which is exactly what this program does, but this may change at any time. Use Farsight at your own risk. Anti Cheat does not ban for programs used during spectate, but it does however run while in a live game. Having Farsight open during a live (non-spectate) game may lead to account bans incase checks to stop it from running fail for some reason."
    })

    if (choice === 1) {
      return
    }

    Sender.emit<number>(this.id, 1)

    const version = await this.lcu.request<string>({
      method: 'GET',
      url: '/lol-patch/v1/game-version'
    })

    if (version === undefined) return

    setVersion(version.split('.', 2).join('.'))

    this._connectToLeague()
  }

  private async _connectToLeague() {
    const res = await connectToLeague()
    this.isConnected = res

    if (res) {
      if (this.menuItem) {
        this.menuItem.checked = true
      }

      this.interval = setInterval(async () => {
        this.getData()
      }, 1000)
    } else {
      setTimeout(() => {
        this._connectToLeague()
      }, 5000)
    }
  }

  /**
   * Gets data from the live-game api
  */
  private async getData(): Promise<void> {
    if (!isReady() || !this.isConnected) {
      this.isConnected = await connectToLeague()
      Sender.emit(this.id, 1)
      return
    }

    try {
      const data = makeSnapshot()

      if (!isReady() || !this.isConnected) {
        Sender.emit(this.id, 1)
        return
      }

      const obj: LPTEvent = {
        meta: {
          namespace: this.namespace,
          type: 'farsight-data',
          version: 1
        },
        data: data
      }
      this.server.send(obj)

      Sender.emit(this.id, 2)
    } catch (e) {
      Sender.emit(this.id, 1)
      
      this.logger.error(e)

      Sender.emit('error', {
        color: "error",
        title: 'Error while fetching game data',
        message: (e as Error).message
      } as DisplayError)
    }
  }

  /**
   * Clears timeout to stop requesting live-game data
  */
  public disconnect(): void {
    Sender.emit(this.id, 0)

    if (this.menuItem) {
      this.menuItem.checked = false
    }

    disconnectFromLeague()

    if (this.interval) {
      clearInterval(this.interval)
    }
  }

/*   private async saveData() {
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
      const saveData = JSON.stringify(this.data, null, 2)
      const savePath = saveDialog.filePath.toString()
      await writeFile(savePath, saveData)
    }
  } */
}