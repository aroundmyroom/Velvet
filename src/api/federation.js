import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import httpProxy from 'http-proxy';
import * as sync from '../state/syncthing.js';
import * as config from '../state/config.js';
import { joiValidate } from '../util/validation.js';

export function setup(velvet) {
  // Stats endpoint is registered BEFORE the enabled-check middleware so the
  // admin UI can always call it without getting a 4xx red console error.
  // Returns { enabled: false } when federation is off instead of 405.
  velvet.get('/api/v1/federation/stats', (req, res) => {
    if (config.program.federation.enabled === false) {
      return res.json({ enabled: false });
    }
    res.json({
      enabled: true,
      deviceId: sync.getId(),
      uiAddress: sync.getUiAddress()
    });
  });

  velvet.all('/api/v1/federation/{*path}', (req, res, next) => {
    if (config.program.federation.enabled === false) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (config.program.lockAdmin === true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    if (req.user.admin !== true) { return res.status(405).json({ error: 'Admin API Disabled' }); }
    next();
  });

  velvet.post('/api/v1/federation/invite/accept', (req, res) => {
    const schema = Joi.object({
      url: Joi.string().uri().required(),
      vpaths: Joi.array().items(Joi.string()).required(),
      invite: Joi.string().required(),
      accessAll: Joi.boolean().required()
    });
    joiValidate(schema, req.body);

    const newURL = new URL(req.body.url);
    newURL.pathname = '/federation/invite/exchange';

    // NOTE(pending): implement full invite exchange (requires two-way handshake)
    res.json({});
  });

  velvet.post('/api/v1/federation/invite/generate', (req, res) => {
    const schema = Joi.object({
      vpaths: Joi.array().items(Joi.string()),
      url: Joi.string().optional()
    });
    joiValidate(schema, req.body);

    const vPaths = {};
    req.body.vpaths.forEach(p => {
      if (!config.program.folders[p]) { return; }
      if(typeof sync.getPathId(p) === 'string') {
        vPaths[p] = crypto.createHash('sha256').update(sync.getPathId(p)).digest('base64');
      }
    });

    // Setup Token Data
    const tokenData = {
      federationInvite: true,
      vPaths: vPaths,
      username: req.user.username
    };

    if(typeof req.body.url === 'string') {
      tokenData.url = req.body.url;
    }

    res.json({ token: jwt.sign(tokenData, config.program.secret, {}) });
  });

  const apiProxy = httpProxy.createProxyServer();

  apiProxy.on('proxyReq', (proxyReq, req, _res, _options) => {
    proxyReq.path = proxyReq.path.replaceAll('/api/v1/syncthing-proxy', '');

    if (proxyReq.path.charAt(0) !== '/') {
      proxyReq.path = '/' + proxyReq.path;
    }

    if (req.body) {
      const bodyData = JSON.stringify(req.body);
      // incase if content-type is application/x-www-form-urlencoded -> we need to change to application/json
      proxyReq.setHeader('Content-Type','application/json');
      proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
      // stream the content
      proxyReq.write(bodyData);
    }
  });

  apiProxy.on('error', (err, req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Something went wrong. And we are reporting a custom error message.');
  });

  velvet.all('/api/v1/syncthing-proxy/{*path}', (req, res) => {
    // Add the auth token as a cookie so all contents of the iframe use it
    if (req.token) { res.cookie('x-access-token', req.token); }
    apiProxy.web(req, res, {target: 'http://' + sync.getUiAddress(), changeOrigin: true}); // NOSONAR: proxying to Syncthing's local-only HTTP API — http correct for loopback
  });

  velvet.all('/api/v1/syncthing-proxy/', (req, res) => {
    // Add the auth token as a cookie so all contents of the iframe use it
    if (req.token) { res.cookie('x-access-token', req.token); }
    apiProxy.web(req, res, {target: 'http://' + sync.getUiAddress(), changeOrigin: true}); // NOSONAR: proxying to Syncthing's local-only HTTP API — http correct for loopback
  });
}
