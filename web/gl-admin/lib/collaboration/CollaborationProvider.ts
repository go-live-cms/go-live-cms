import { WebsocketProvider } from 'y-websocket'
import { Doc as YDoc } from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { authManager } from '../auth'

export class CollaborationProvider {
  public doc: YDoc
  public provider: WebsocketProvider
  public persistence: IndexeddbPersistence
  private postId: number

  constructor(postId: number) {
    this.postId = postId
    this.doc = new YDoc()
    
    // Setup IndexedDB persistence for offline support
    this.persistence = new IndexeddbPersistence(`post-${postId}`, this.doc)
    
    // Get user info for presence
    const user = authManager.getState().user
    const userInfo = {
      name: user?.full_name || user?.username || 'Anonymous',
      color: this.generateUserColor(user?.id || 0),
      id: user?.id || 0
    }

    // Setup WebSocket provider
    this.provider = new WebsocketProvider(
      process.env.NODE_ENV === 'development' 
        ? 'ws://localhost:1234' 
        : 'wss://your-domain.com/collab',
      `post-${postId}`,
      this.doc,
      {
        params: {
          // This will be used for auth
          token: authManager.getToken()
        }
      }
    )

    // Set user awareness info for cursors/presence
    this.provider.awareness.setLocalStateField('user', userInfo)

    // Connection event handlers
    this.provider.on('status', (event: any) => {
      console.log('Collaboration status:', event.status) // connecting, connected, disconnected
    })

    this.provider.on('connection-close', () => {
      console.log('Collaboration connection closed')
    })

    this.provider.on('connection-error', () => {
      console.log('Collaboration connection error')
    })
  }

  private generateUserColor(userId: number): string {
    // Generate consistent color for user based on ID
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', 
      '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'
    ]
    return colors[userId % colors.length]
  }

  public destroy() {
    this.persistence?.destroy()
    this.provider?.destroy()
    this.doc?.destroy()
  }

  public getConnectionStatus() {
    return this.provider.wsconnected ? 'connected' : 'disconnected'
  }

  public getConnectedUsers() {
    const states = this.provider.awareness.getStates()
    return Array.from(states.values()).map(state => state.user).filter(Boolean)
  }
}