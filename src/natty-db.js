"use strict";

const RSVP = require('rsvp');
const ajax = require('./ajax');
const jsonp = require('./jsonp');
const util = require('./util');

const {extend, runAsFn, isAbsoluteUrl, isRelativeUrl, noop, isBoolean, isFunction, isNumber, isArray} = util;

RSVP.on('error', function(reason) {
    console.assert('rsvp error:\n' + reason);
});

/**
 * 如果浏览器`url`中包含`m=1`的`search`参数，则开启全局`mock`模式
 * NOTE 每个接口的私有`mock`配置优先级高于该全局值。
 */
const isGlobalMock = !!location.search.match(/\bm=1\b/);

const EMPTY = '';
const TRUE = true;
const FALSE = !TRUE;

// 伪造的`promise`对象
// NOTE 伪造的promise对象要支持链式调用 保证和`new RSVP.Promise()`返回的对象行为一致
//      dummyPromise.then().catch().finally()
let dummyPromise = {
    dummy: TRUE
};
dummyPromise.then = dummyPromise['catch'] = dummyPromise['finally'] = () => {
    // NOTE 这里用了剪头函数 不能用`return this`
    return dummyPromise;
};

// 全局默认配置
// NOTE 全局配置中不包含`url`和`mockUrl`, 因为无意义
const defaultGlobalConfig = {

    // 默认参数
    data: {},

    // 预处理回调
    fit: noop,

    // 自定义header, 只针对ajax有效
    header: {},

    // 是否忽律自身的并发请求
    ignoreSelfConcurrent: FALSE,

    // 有两种格式配置`jsonp`的值
    // {Boolean}
    // {Array} eg: [true, 'cb', 'j{id}']
    jsonp: FALSE,

    // 是否开启log信息
    log: FALSE,

    // 非GET方式对JSONP无效
    method: 'GET',

    // 是否开启mock模式
    mock: FALSE,

    // 是否缓存数据
    once: FALSE,

    // 成功回调
    process: noop,

    // 默认不执行重试
    retry: 0,

    // 0表示不启动超时处理
    timeout: 0,

    // 全局url前缀
    urlPrefix: EMPTY
};

let runtimeGlobalConfig = {};

class DB {
    // TODO 检查参数合法性
    constructor(name, APIs, context) {
        let t = this;
        t.context = context;

        t.cache = {};
        t.name = name;
        for (let API in APIs) {
            t[API] = t.createAPI(extend({
                DBName: name,
                API: API
            }, runAsFn(APIs[API])));
        }
    }

    /**
     * 处理API的配置
     * @param options {Object}
     */
    processAPIOptions(options) {
        let t = this;

        let config = extend({}, t.context, options);

        // 标记是否正在等待请求返回
        config.pending = false;

        // dip平台不支持GET以外的类型
        // TODO 是否拿出去
        if (config.mock) {
            config.method = 'GET';
        }

        config.mockUrl = options.mockUrl || EMPTY;

        config.url = config.mock ? config.mockUrl : t.getFullUrl(options.url);


        if (isBoolean(options.jsonp)) {
            config.jsonp = options.jsonp;
        }

        // 按照[boolean, callbackKeyWord, callbackFunctionName]格式处理
        else if (isArray(options.jsonp)) {
            config.jsonp = isBoolean(options.jsonp[0]) ? options.jsonp[0] : FALSE;
            // 这个参数只用于jsonp
            if (config.jsonp) {
                config.jsonpFlag = options.jsonp[1];
                config.jsonpCallbackName = options.jsonp[2];
            }
        }

        // 配置自动增强 如果`url`的值有`.jsonp`结尾 则认为是`jsonp`请求
        // NOTE jsonp是描述正式接口的 不影响mock接口!!!
        else {
            config.jsonp = !!config.url.match(/\.jsonp(\?.*)?$/);
        }

        if (config.mock) {
            config.data.m = '1';
        }
        config.data['request'] = t.name + '.' + config.API;

        // TODO 代理功能

        return config;
    }

    createAPI(options) {
        let t = this;
        let config = t.processAPIOptions(options);

        // api函数体
        let api = (data) => {

            // 是否忽略自身的并发请求
            if (config.ignoreSelfConcurrent && config.pending) {
                return dummyPromise;
            }

            if (config.retry === 0) {
                return t.request(data, config);
            } else {
                return t.tryRequest(data, config);
            }
        };

        api.config = config;
        t.addLoopSupport(api);

        return api;
    }

    /**
     * 创建轮询支持
     * @param api {Function} 需要轮询的函数
     */
    addLoopSupport(api) {
        let loopTimer = null;
        api.looping = FALSE;
        // 开启轮询
        api.startLoop = (options) => {
            if (!options.duration || !isNumber(options.duration)) {
                throw new Error('illegal `duration` value for `startLoop` method.');
                return api;
            }

            let sleepAndRequest = () => {
                api.looping = TRUE;
                loopTimer = setTimeout(() => {
                    api(options.data).then(options.process, noop);
                    sleepAndRequest();
                }, options.duration);
            };

            // NOTE 轮询过程中是不响应服务器端错误的 所以第二个参数是`noop`
            api(options.data).then(options.process, noop);
            sleepAndRequest();
        };
        // 停止轮询
        api.stopLoop = () => {
            clearTimeout(loopTimer);
            api.looping = FALSE;
            loopTimer = null;
        };
    }

    /**
     * 获取正式接口的完整`url`
     */
    getFullUrl(url) {
        if (!url) return EMPTY;
        return (this.context.urlPrefix && !isAbsoluteUrl(url) && !isRelativeUrl(url)) ? this.context.urlPrefix + url : url;
    }

    /**
     * 发起请求
     * @param data {Object} 发送的数据
     * @param config {Object} 已经处理完善的请求配置
     * @param retryTime {undefined|Number} 如果没有重试 将是undefined值 见`createAPI`方法
     *                                     如果有重试 将是重试的当前次数 见`tryRequest`方法
     * @returns {Object} RSVP.defer()
     */
    request(data, config, retryTime) {
        let t = this;

        // `data`必须在请求发生时实时创建
        data = extend({}, config.data, runAsFn(data, {
            retryTime
        }));

        // 根据`config`的差别 请求对象分为`ajax`和`jsonp`两种
        let requester;

        // 等待状态在此处开启 在相应的`requester`的`complete`回调中关闭
        config.pending = TRUE;

        let defer = RSVP.defer();

        if (config.once && t.cache[config.API]) {
            defer.resolve(t.cache[config.API]);
            config.pending = false;
        } else if (config.jsonp) {
            requester = t.sendJSONP(data, config, defer, retryTime);
        } else {
            requester = t.sendAjax(data, config, defer, retryTime);
        }

        // 超时处理
        if (0 !== config.timeout) {
            setTimeout(() => {
                if (config.pending) {
                    // 取消请求
                    requester.abort();
                    defer.reject({
                        timeout: TRUE,
                        message: 'Timeout By ' + config.timeout + 'ms.'
                    });
                }
            }, config.timeout);
        }

        return defer.promise;
    }

    /**
     * 重试功能的实现
     * @param data {Object} 发送的数据
     * @param config
     * @returns {Object} RSVP.defer()
     */
    tryRequest(data, config) {
        let t = this;

        let defer = RSVP.defer();
        let retryTime = 0;
        let request = () => {
            t.request(data, config, retryTime).then((data) => {
                defer.resolve(data);
            }, (error) => {
                if (retryTime === config.retry) {
                    defer.reject(error);
                } else {
                    retryTime++;
                    request();
                }
            });
        };

        request();
        return defer.promise;
    }

    /**
     * 处理结构化的响应数据
     * @param config
     * @param response
     * @param defer
     */
    processResponse(config, response, defer) {
        // 非标准格式数据的预处理
        response = config.fit(response);

        if (response.success) {
            // 数据处理
            let responseData = config.process(response.content);

            // 记入缓存
            config.once && (t.cache[config.API] = responseData);
            defer.resolve(responseData);
        } else {
            // TODO error的格式约定
            // TODO 测试
            // NOTE response是只读的对象!!!
            defer.reject(extend({
                message: 'Server Process Failed (NattyDB Default Message)'
            }, response.error));
        }
    }

    /**
     * 发起Ajax请求
     * @param config {Object} 请求配置
     * @param defer {Object} RSVP.defer()的对象
     * @param retryTime {undefined|Number} 如果没有重试 将是undefined值 见`createAPI`方法
     *                                     如果有重试 将是重试的当前次数 见`tryRequest`方法
     * @returns {Object} xhr对象实例
     */
    sendAjax(data, config, defer, retryTime) {
        let t = this;

        return ajax({
            log: config.log,
            url: config.url,
            method: config.method,
            data: data,
            header: config.header,

            // 强制约定json
            accept: 'json',
            success(response/*, xhr*/) {
                t.processResponse(config, response, defer);
            },
            error(status/*, xhr*/) {

                let message;
                let flag;
                switch (status) {
                    case 404:
                        message = 'Not Found';
                        break;
                    case 500:
                        message = 'Internal Server Error';
                        break;
                    // TODO 是否要补充其他明确的服务端错误
                    default:
                        message = 'Unknown Server Error';
                        break;
                }

                defer.reject({
                    status,
                    message
                });
            },
            complete(/*status, xhr*/) {
                if (retryTime === undefined || retryTime === config.retry) {
                    config.pending = false;
                }
                //console.log('__complete: pending:', config.pending, 'retryTime:', retryTime, Math.random());
            }
        });
    }

    /**
     * 发起jsonp请求
     * @param config {Object} 请求配置
     * @param defer {Object} RSVP.defer()的对象
     * @param retryTime {undefined|Number} 如果没有重试 将是undefined值 见`createAPI`方法
     *                                     如果有重试 将是重试的当前次数 见`tryRequest`方法
     * @returns {Object} 带有abort方法的对象
     */
    sendJSONP(data, config, defer, retryTime) {
        let t = this;
        return jsonp({
            log: config.log,
            url: config.url,
            data: data,
            cache: config.cache,
            flag: config.jsonpFlag,
            callbackName: config.jsonpCallbackName,
            success(response) {
                t.processResponse(config, response, defer);
            },
            error(e) {
                defer.reject({
                    message: 'Not Accessable JSONP URL `' + e.target.src + '`'
                });
            },
            complete() {
                if (retryTime === undefined || retryTime === config.retry) {
                    config.pending = false;
                }
                //console.log('complete: pending:', config.pending);
            }
        });
    }
}


// 设计说明：
//  1 jsonp不是"数据类型" 但很多人沟通时不经意使用"数据类型"这个词 因为jQuery/zepto的配置就是使用`dataType: 'jsonp'`

/**
 * 关键词
 *     语意化的
 *     优雅的
 *     功能增强的
 *     底层隔离的
 *
 * 创建一个上下文
 *     let DBC = new NattyDB.Context({
 *          urlPrefix: 'xxx',
 *          mock: false,
 *          data: {
 *              token: 'xxx
 *          },
 *          timeout: 30000
 *     });
 * 创建一个DB
 *     let User = DBC.create('User', {
 *         getPhone: {
 *             url: 'xxx',
 *             mock: false,
 *             mockUrl: 'path',
 *
 *             method: 'GET',                // GET|POST
 *             data: {},                     // 固定参数
 *             header: {},                   // 非jsonp时才生效
 *             timeout: 5000,                // 如果超时了，会触发error
 *
 *             jsonp: false,                 // true
 *             jsonp: [true, 'cb', 'j{id}'], // 自定义jsonp的query string
 *
 *             fit: fn,
 *             process: fn,
 *
 *             once: false,
 *             retry: 0,
 *             ignoreSelfConcurrent: true,
 *
 *             log: true
 *         }
 *     });
 *
 * 使用
 *     User.getPhone({
 *         // 动态参数
 *     }).then(function () {
 *         // 成功回调
 *     }, function (error) {
 *         // 失败回调
 *         if (error.status == 404) {} // ajax方法才有error.status
 *         if (error.status == 500) {} // ajax方法才有error.status
 *         if (error.status == 0)      // ajax方法才有error.status 0表示不确定的错误 可能是跨域时使用了非法Header
 *         if (error.timeout) {
 *             console.log(error.message)
 *         }
 *
 *         // 服务器端返回的错误
 *         if (error.code == 10001) {}
 *     });
 *
 *     // 动态参数也可以是函数
 *     User.getPhone(function() {
 *         return {}
 *     }).then(function(){
 *         // 成功回调
 *     });
 *
 *     // 发起轮询
 *     // NOTE 轮询过程中是不响应服务器端错误的
 *     Driver.getDistance.startLoop({
 *         // 轮询发送的请求数据
 *         data: {},
 *         // 轮询发送的请求数据也支持函数
 *         data: function() {
 *             return {};
 *         },
 *
 *         // 间隔时间
 *         duration: 5000,
 *
 *         // 轮询的响应回调
 *         process: function(data) {}
 *     });
 *
 *     // 停止轮询
 *     // NOTE 关闭轮询的唯一方法就是stopLoop方法
 *     Driver.getDistance.stopLoop();
 *
 *     // 暂不支持
 *     NattyDB.addAccept('hbs', function(text){
 *         return Handlebars.compile(text);
 *     });
 *
 */

class Context {
    /**
     * @param options 一个DB实例的通用配置
     */
    constructor(options) {
        let t = this;
        t.config = extend({}, runtimeGlobalConfig, options);
    }

    create(name, APIs) {
        let t = this;
        // NOTE 强制不允许重复的DB名称
        if (t[name]) {
            console.warn('DB: "' + name + '" is existed! ');
            return;
        }
        return t[name] = new DB(name, APIs, t.config);
    }
}

let NattyDB = {
    version: '1.0.0',
    Context,
    util,
    /**
     * 执行全局配置
     * @param options
     */
    setGlobal(options) {
        runtimeGlobalConfig = extend({}, defaultGlobalConfig, options);
    },
    /**
     * 获取全局配置
     * @param property {String} optional
     * @returns {*}
     */
    getGlobal(property) {
        return property ? runtimeGlobalConfig[property] : runtimeGlobalConfig;
    }
};

// 内部直接将运行时的全局配置初始化到默认值
NattyDB.setGlobal(defaultGlobalConfig);

if (typeof define !== "undefined" && define !== null && define.amd) {
    define(function() {
        return NattyDB;
    });
} else if (typeof module !== "undefined" && module !== null && module.exports) {
    module.exports = NattyDB;
} else {
    window.NattyDB = NattyDB;
}