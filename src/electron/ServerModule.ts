import { ipcMain, dialog, app, MenuItem, Menu } from 'electron';
import * as path from "path";
import * as fs from "fs";
import { Sender } from './Sender';
import { Server } from './Server';
import { LCU } from './LCU'
import type { ServerRequest } from '../../types/ServerRequest'
import type { ServerResponse } from '../../types/ServerResponse'

export class ServerModule {
  private data : Array<any> = []

  constructor (
    public id : string,
    public name : string,
    private serverURI : string,
    private lcu : LCU,
    private server : Server,
    private menu : Menu,
  ) {
    ipcMain.on(`${id}-start`, () => {
      this.connect()
    })
    ipcMain.on(`${id}-stop`, () =>{
      this.disconnect()
    })
    ipcMain.on(`${id}-save`, () => {
      this.saveData()
    })

    this.menu.getMenuItemById('tools').submenu?.append(new MenuItem({
      id: this.id,
      label: this.name,
      type: 'checkbox',
      checked: false,
      click : (e) => {
        if (e.checked) {
          this.connect()
        } else {
          this.disconnect()
        }
      }
    }))
  }

  public connect () {
    this.server.subscribe(this.serverURI, (data: ServerRequest) => this.handleData(data))
    Sender.send(this.id, true)
    this.menu.getMenuItemById(this.id).checked = true
  }

  private async handleData(data: ServerRequest) {
    const res = await this.lcu.request(data.request)

    this.data.push({
      meta: data.meta,
      data: res
    })

    const obj : ServerResponse = {
      meta: {
        namespace: "reply",
        type: data.meta.reply,
        version: data.meta.version
      },
      data: res
    }
    Sender.send(`console`, obj)
    this.server.send(JSON.stringify(obj))
  }

  public disconnect () {
    this.lcu.unsubscribe(this.serverURI);
    Sender.send(this.id, false)
    this.menu.getMenuItemById(this.id).checked = false
  }

  private async saveData () {
    const saveDialog = await dialog.showSaveDialog({
      title: 'Select the File Path to save',
      defaultPath: path.join(app.getPath('documents'), `../Observer Tool/${this.name}-data.json`),
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
      const saveData = JSON.stringify(this.data)
      const savePath = saveDialog.filePath.toString()
      fs.writeFile(savePath, saveData, (err) => {
          if (err) throw err;
          Sender.send('console', `Saved at ${savePath}`)
      });
    }
  }
}