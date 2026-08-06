import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/knowledge-base'

export const knowledgeBaseRoutes = new Router()

// Knowledge base CRUD
knowledgeBaseRoutes.get('/api/hermes/knowledge-bases', ctrl.listKbs)
knowledgeBaseRoutes.post('/api/hermes/knowledge-bases', ctrl.createKb)
knowledgeBaseRoutes.get('/api/hermes/knowledge-bases/:id', ctrl.getKb)
knowledgeBaseRoutes.patch('/api/hermes/knowledge-bases/:id', ctrl.updateKb)
knowledgeBaseRoutes.delete('/api/hermes/knowledge-bases/:id', ctrl.deleteKb)

// Document CRUD
knowledgeBaseRoutes.get('/api/hermes/knowledge-bases/:kbId/documents', ctrl.listDocs)
knowledgeBaseRoutes.post('/api/hermes/knowledge-bases/:kbId/documents', ctrl.addDoc)
knowledgeBaseRoutes.post('/api/hermes/knowledge-bases/:kbId/documents/upload', ctrl.uploadDoc)
knowledgeBaseRoutes.get('/api/hermes/knowledge-bases/:kbId/documents/:docId', ctrl.getDoc)
knowledgeBaseRoutes.get('/api/hermes/knowledge-bases/:kbId/documents/:docId/content', ctrl.getDocContent)
knowledgeBaseRoutes.delete('/api/hermes/knowledge-bases/:kbId/documents/:docId', ctrl.deleteDoc)

// Query
knowledgeBaseRoutes.post('/api/hermes/knowledge-bases/query', ctrl.query)
