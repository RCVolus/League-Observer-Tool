import WebSocket from "ws";
import { ipcMain } from 'electron';
import { Sender } from '../helper/Sender';
import { DisplayError } from '../../types/DisplayError';
import type { LPTEvent } from '../../types/LPTE'
import { store } from '../index'
import uniqid from 'uniqid'
import log from 'electron-log';

enum EventType {
  BROADCAST = 'BROADCAST',
  REQUEST = 'REQUEST',
  REPLY = 'REPLY'
}

export class Server {
  private ws?: WebSocket
  private timeout?: NodeJS.Timeout
  private prodClockInterval?: NodeJS.Timeout
  public prodTimeOffset = 0
  private serverIP: string
  private serverPort: number
  private apiKey: string
  private isClosing = false
  private InitConnection = true
  private subscriptions: Map<string, ((data: LPTEvent) => void)[]> = new Map()
  public isConnected = false
  private logger: log.LogFunctions
  private connectionHandlers: Array<() => void> = []

  constructor() {
    this.logger = log.scope('Server')

    this.serverIP = store.get("server-ip")
    this.serverPort = store.get("server-port")
    this.apiKey = store.get("server-api-key")

    store.onDidChange('server-ip', (newValue, oldValue) => {
      if (oldValue === undefined || oldValue === newValue || newValue === undefined) return

      this.serverIP = newValue

      if (this.isConnected) {
        this.disconnect()

        setTimeout(() => {
          this.connect()
        }, 1000)
      }
    })

    store.onDidChange('server-port', (newValue, oldValue) => {
      if (oldValue === undefined || oldValue === newValue || newValue === undefined) return

      this.serverPort = newValue

      if (this.isConnected) {
        this.disconnect()

        setTimeout(() => {
          this.connect()
        }, 1000)
      }
    })

    store.onDidChange('server-api-key', (newValue, oldValue) => {
      if (oldValue === undefined || oldValue === newValue || newValue === undefined) return

      this.apiKey = newValue

      if (this.isConnected) {
        this.disconnect()

        setTimeout(() => {
          this.connect()
        }, 1000)
      }
    })

    ipcMain.handle('server-connection-start', () => {
      this.connect()
    })
  }

  /**
   * connect
  */
  public connect(): void {
    const wsURI = `ws://${this.serverIP}:${this.serverPort}/eventbus?apikey=${this.apiKey}`
    this.ws = new WebSocket(wsURI)

    this.ws.onopen = () => {
      this.isClosing = false
      this.InitConnection = false
      this.isConnected = true

      Sender.emit('server-connection', this.isConnected)

      this._onConnected()
      this.syncProdClock()
    }

    this.ws.onmessage = (content) => {
      const json = JSON.parse(content.data.toString()) as LPTEvent

      if (this.subscriptions.has(`${json.meta.namespace}-${json.meta.type}`)) {
        this.subscriptions.get(`${json.meta.namespace}-${json.meta.type}`)?.forEach((cb) => {
          cb(json)
        })
      }
    }

    this.ws.onerror = e => {
      this.isConnected = false
      this.logger.error(e)

      Sender.emit('error', {
        color: "error",
        title: 'Prod-Tool connection issue',
        message: e.message,
      } as DisplayError)

      Sender.emit('server-connection', this.isConnected)
    }

    this.ws.onclose = () => {
      this.isConnected = false
      Sender.emit('server-connection', this.isConnected)

      if (!this.isClosing && !this.InitConnection) {
        this.timeout = setTimeout(() => { this.connect() }, 5000)
      }
    }
  }

  public onConnected(handler: () => void): void {
    if (this.isConnected) {
      handler()
    } else {
      this.connectionHandlers.push(handler)
    }
  }

  private _onConnected(): void {
    this.connectionHandlers.forEach(handler => {
      handler()
    })
  }

  public subscribe(namespace: string, type: string, effect: (data: LPTEvent) => void): void {
    if (!this.isConnected) return

    if (!this.subscriptions.has(`${namespace}-${type}`)) {
      const msg: LPTEvent = {
        meta: {
          namespace: "lpte",
          type: "subscribe"
        },
        to: {
          namespace: namespace,
          type: type
        }
      }
      this.send(msg)
      this.subscriptions.set(`${namespace}-${type}`, [effect])
    } else {
      this.subscriptions.get(`${namespace}-${type}`)?.push(effect)
    }
  }

  public subscribeOnce(namespace: string, type: string, effect: (data: LPTEvent) => void): void {
    if (!this.isConnected) return

    const onceWrapper = (data: LPTEvent) => {
      this.unsubscribe(namespace, type)
      effect(data)
    }

    if (!this.subscriptions.has(`${namespace}-${type}`)) {
      const msg: LPTEvent = {
        meta: {
          namespace: "lpte",
          type: "subscribe"
        },
        to: {
          namespace: namespace,
          type: type
        }
      }
      this.send(msg)
      this.subscriptions.set(`${namespace}-${type}`, [onceWrapper])
    } else {
      this.subscriptions.get(`${namespace}-${type}`)?.push(onceWrapper)
    }
  }

  public unsubscribe(namespace: string, type: string): void {
    if (!this.isConnected) return
    this.subscriptions.delete(`${namespace}-${type}`)
  }

  /**
   * disconnect
  */
  public disconnect(): void {
    this.isClosing = true
    this.InitConnection = true
    this.ws?.close()

    if (this.timeout) {
      clearTimeout(this.timeout)
    }

    if (this.prodClockInterval) {
      clearInterval(this.prodClockInterval)
    }

    this.isConnected = false
    Sender.emit('server-connection', this.isConnected)
  }

  /**
   * send
  */
  public send(data: LPTEvent): void {
    if (!this.isConnected) return

    this.ws?.send(JSON.stringify(data), (err) => {
      if (err) {
        this.logger.error(err)
        throw err
      }
    })
  }

  public async request(event: LPTEvent, timeout = 5000): Promise<LPTEvent> {
    if (!this.isConnected) throw new Error('not connected to prod tool')

    const reply = `${event.meta.type}-${uniqid()}`
    event.meta.reply = reply
    event.meta.channelType = EventType.REQUEST

    setTimeout(() => {
      this.send(event)
    }, 0)

    try {
      return await this.await('reply', reply, timeout)
    } catch {
      this.logger.error('request timed out')
      throw new Error('request timed out')
    }
  }

  public async await(namespace: string, type: string, timeout = 5000): Promise<LPTEvent> {
    if (!this.isConnected) throw new Error('not connected to prod tool')

    return await new Promise((resolve, reject) => {
      let wasHandled = false

      const handler = (e: LPTEvent): void => {
        if (wasHandled) {
          return
        }
        wasHandled = true
        this.unsubscribe(namespace, type)

        resolve(e)
      }
      // Register handler
      this.subscribe(namespace, type, handler)

      setTimeout(() => {
        if (wasHandled) {
          return
        }
        wasHandled = true
        this.unsubscribe(namespace, type)
        reject(new Error('request timed out'))
      }, timeout)
    })
  }

  public async getLocalTimeOffset(): Promise<number> {
    // Get before time to measure roundtrip time to server
    const beforeTime = new Date().getTime();

    // Send request
    const response = await this.request({
      meta: {
        namespace: 'plugin-prod-clock',
        type: 'request-sync',
        version: 1
      }
    });

    const afterTime = new Date().getTime();
    const serverTime = response.time as number;

    // Calculate roundtrip time (ping)
    const ping = afterTime - beforeTime;

    // We assume that the packet had the same time to travel client -> server, as it travels server -> client. Thus we have to remove half of the ping time from the server time to justify it correctly

    const justifiedServerTime = serverTime - (ping / 2);

    // Now we can use the justified server time to calculate the offset to the local clock.
    // This localOffset variable should be saved for a longer time
    const localOffset = justifiedServerTime - new Date().getTime();

    // Now whenever you need to get the current server time, do the following:
    // const currentServerTime = new Date(new Date().getTime() + localOffset);

    return localOffset;
  }

  private async syncProdClock() {
    const offset = await this.getLocalTimeOffset()
    this.prodTimeOffset = offset
    Sender.emit('server-prod-clock', offset)

    this.prodClockInterval = setInterval(async () => {
      if (!this.isConnected) return
      const offset = await this.getLocalTimeOffset()
      this.prodTimeOffset = offset
      Sender.emit('server-prod-clock', offset)
    }, 1000 * 60)
  }
}