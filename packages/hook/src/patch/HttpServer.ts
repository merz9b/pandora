'use strict';

import { Patcher, getRandom64 } from 'pandora-metrics';
import { extractPath } from '../utils/Utils';
import { HEADER_TRACE_ID } from '../utils/Constants';
import { parse as parseUrl } from 'url';
import { parse as parseQS, ParsedUrlQuery } from 'querystring';
import * as http from 'http';

const debug = require('debug')('Pandora:Hook:HttpServerPatcher');

export type bufferTransformer = (buffer) => object | string;

export type requestFilter = (req) => boolean;

export class HttpServerPatcher extends Patcher {

  constructor(options?: {
    recordGetParams?: boolean,
    recordPostData?: boolean,
    bufferTransformer?: bufferTransformer,
    requestFilter?: requestFilter
  }) {
    super(options || {});

    this.shimmer(this.options);
  }

  getModuleName() {
    return 'httpServer';
  }

  getModule() {
    return http;
  }

  getTraceId(req) {
    return req.headers[HEADER_TRACE_ID] || getRandom64();
  }

  createSpan(tracer, tags) {
    const span = tracer.startSpan('http', {
      traceId: tracer.traceId
    });

    span.addTags(tags);

    return span;
  }

  createTracer(req) {
    const traceId = this.getTraceId(req);

    return this.getTraceManager().create({ traceId });
  }

  buildTags(req) {

    return {
      'http.method': {
        value: req.method.toUpperCase(),
        type: 'string'
      },
      'http.url': {
        value: extractPath(req.url),
        type: 'string'
      },
      'http.client': {
        value: false,
        type: 'bool'
      }
    };
  }

  /**
   * 过滤请求，按需实现
   * @param {HttpRequest} req - Http 请求
   * @returns {Boolean} 是否被忽略
   */
  requestFilter(req) {
    return false;
  }

  _beforeExecute(tracer, req, res) {}

  beforeFinish(span, res) {
    span.setTag('http.status_code', {
      type: 'number',
      value: res.statusCode
    });
  }

  processGetParams(req) {
    const url = req.url;

    if (url) {
      let urlParsed;

      try {
        urlParsed = parseUrl(url, true);
      } catch (error) {
        debug('process get params error. ', error);

        return {};
      }

      return urlParsed.query;
    }

    return {};
  }

  bufferTransformer(buffer): ParsedUrlQuery | string {
    try {
      return parseQS(buffer.toString('utf8'));
    } catch (error) {
      debug('transform post data error. ', error);
      return '';
    }
  }

  shimmer(options) {
    const self = this;
    const traceManager = this.getTraceManager();

    this.getShimmer().wrap(this.getModule(), 'createServer', function wrapCreateServer(createServer) {

      return function wrappedCreateServer(this: any, requestListener) {
        if (requestListener) {

          const listener = traceManager.bind(function(req, res) {
            const requestFilter = options.requestFilter || self.requestFilter;

            if (requestFilter(req)) {
              debug('request filter by requestFilter, skip trace.');
              return requestListener(req, res);
            }

            traceManager.bindEmitter(req);
            traceManager.bindEmitter(res);

            const tracer = self.createTracer(req);
            self._beforeExecute(tracer, req, res);
            const tags = self.buildTags(req);
            const span = self.createSpan(tracer, tags);

            if (options.recordGetParams) {
              const query = self.processGetParams(req);

              span.log({
                query
              });
            }

            let chunks = [];
            if (options.recordPostData && req.method && req.method.toUpperCase() === 'POST') {
              req.on('data', (chunk) => {
                chunks.push(chunk);
              });
            }

            tracer.named(`HTTP-${tags['http.method'].value}:${tags['http.url'].value}`);
            tracer.setCurrentSpan(span);

            res.once('finish', () => {

              if (options.recordPostData && req.method && req.method.toUpperCase() === 'POST') {
                const transformer = options.bufferTransformer || self.bufferTransformer;
                const postData = transformer(chunks);

                span.log({
                  data: postData
                });
                // clear cache
                chunks = [];
              }

              self.beforeFinish(span, res);
              span.finish();
              tracer.finish(options);
              self.afterFinish(span, res);
            });

            return requestListener(req, res);
          });

          return createServer.call(this, listener);
        }

        debug('no requestListener, skip trace.');
        return createServer.call(this, requestListener);
      };
    });
  }

  afterFinish(span, res) {
    // overwrite
  }
}
