import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createSession, sendTurnStream } from './api'
import './App.css'

function App() {
  const [sessionId, setSessionId] = useState(null)
  const [messages, setMessages] = useState([])
  const [streamingContent, setStreamingContent] = useState('')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const messagesEndRef = useRef(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages, streamingContent])

  const startSession = async () => {
    setError(null)
    try {
      const { session_id } = await createSession()
      setSessionId(session_id)
      setMessages([])
    } catch (err) {
      setError(err.message)
    }
  }

  useEffect(() => {
    startSession()
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || !sessionId || loading) return

    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setMessages((prev) => [...prev, { role: 'assistant', content: '', streaming: true }])
    setStreamingContent('')
    setLoading(true)
    setError(null)

    try {
      await sendTurnStream(sessionId, text, false, {
        onDelta: (chunk) => setStreamingContent((prev) => prev + chunk),
        onDone: ({ reply, pending_approvals }) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.streaming
                ? { ...m, content: reply || '(No reply)', streaming: false }
                : m
            )
          )
          setStreamingContent('')
          if (pending_approvals?.length > 0) {
            const toolNames = pending_approvals.map((p) => p.tool_name).join(', ')
            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: `Tool calls are pending your approval: ${toolNames}`,
                isError: true,
              },
            ])
          }
          setLoading(false)
        },
        onError: (detail) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.streaming
                ? { ...m, content: `Error: ${detail}`, isError: true, streaming: false }
                : m
            )
          )
          setStreamingContent('')
          setError(detail)
          setLoading(false)
        },
      })
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.streaming
            ? { ...m, content: `Error: ${err.message}`, isError: true, streaming: false }
            : m
        )
      )
      setStreamingContent('')
      setError(err.message)
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="header">
        <h1>Agent Chat</h1>
        <span className="session-info">
          {sessionId ? `Session: ${sessionId.slice(0, 8)}…` : 'No session'}
        </span>
        <button type="button" onClick={startSession} className="btn-new">
          New chat
        </button>
      </header>

      <main className="messages">
        <div className="messages-inner">
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`msg msg-${msg.role}${msg.isError ? ' msg-error' : ''}`}
            >
              <span className="msg-role">{msg.role}</span>
              <div className="msg-content">
                {msg.streaming ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {streamingContent || '…'}
                  </ReactMarkdown>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {msg.content}
                  </ReactMarkdown>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="scroll-anchor" ref={messagesEndRef} />
      </main>

      {error && <div className="banner-error">{error}</div>}

      <form onSubmit={handleSubmit} className="form">
        <textarea
          className="input"
          placeholder="Message…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit(e)
            }
          }}
          rows={1}
          disabled={!sessionId || loading}
        />
        <button type="submit" className="btn-send" disabled={!sessionId || loading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  )
}

export default App
