var express = require('express');
var app = express();

var retryTime = 1;

app.all('/api/:test', function (req, res) {

    res.set({
        "Access-Control-Allow-Origin": "*",
        //"Access-Control-Allow-Headers": "Content-Type,Content-Length,Authorization,Accept,X-Requested-With",
        "Access-Control-Allow-Methods": "PUT,POST,GET,DELETE,OPTIONS",

        "Access-Control-Allow-Credentials": true
    });

    switch (req.params.test) {
        // simple test
        case '500':
            res.status(500).json({error: '500'});
            break;
        case '404':
            res.status(404).json({error: '404'});
            break;
        case 'abort':
            setTimeout(function () {
                res.send('abort');
            }, 10000);
            break;
        case 'timeout':
            setTimeout(function () {
                res.json({
                    success: true,
                    content: {
                        id: 1
                    }
                });
            }, 1000);
            break;
        case 'return-script':
            res.send('window.__test__ = 1;');
            break;
        case 'return-json':
            res.json({tool:'natty-db'});
            break;
        case 'return-html':
            res.send('<div>html</div>');
            break;
        case 'return-text':
            res.send('text');
            break;
        case 'return-xml':
            res.send('<div>xml</div>');
            break;
        case 'jsonp-order-create':
            res.jsonp({
                success: true,
                content: {
                    id: 1
                }
            });
            break;
        case 'jsonp-order-create-error':
            res.jsonp({
                success: false,
                error: {
                    code: 1,
                    message: 'Permission Denied'
                }
            });
            break;
        case 'jsonp-timeout':
            setTimeout(function () {
                res.jsonp({
                    success: true,
                    content: {
                        id: 1
                    }
                });
            }, 1000);
            break;

        // return standard data structure
        case 'order-create':
            res.json({
                success: true,
                content: {
                    id: 1
                }
            });
            break;

        // return standard error structure
        case 'return-error':
            res.json({
                success: false,
                error: {
                    code: 1,
                    message: 'Demo Server Error'
                }
            });
            break;

        // return standard error structure
        case 'jsonp-error':
            res.jsonp({
                success: false,
                error: {
                    code: 1,
                    message: 'Demo Server Error'
                }
            });
            break;

        // return non-standard data structure
        case 'order-create-non-standard':
            res.json({
                hasError: false,
                content: {
                    id: 1
                }
            });
            break;
        case 'retry-success':
            if (req.query.retry == '1') {
                retryTime = 1;
            } else {
                retryTime++;
            }
            res.json(retryTime === 2 ? {
                success: true,
                content: {
                    id: 1
                }
            } : {
                success: false,
                error: {
                    code: 1,
                    message: 'Demo Server Error'
                }
            });
            break;
        case 'jsonp-retry-success':
            if (req.query.retry == '1') {
                retryTime = 1;
            } else {
                retryTime++;
            }
            res.jsonp(retryTime === 2 ? {
                success: true,
                content: {
                    id: 1
                }
            } : {
                success: false,
                error: {
                    code: 1,
                    message: 'Demo Server Error'
                }
            });
            break;

        default:
            res.json({
                success: true,
                content: {
                    id: 1
                }
            });
            break;
    }

});

var server = app.listen(8001, function () {
    var host = server.address().address;
    var port = server.address().port;

    console.log('Example app listening at http://%s:%s', host, port);
});
// http://www.bennadel.com/blog/2327-cross-origin-resource-sharing-cors-ajax-requests-between-jquery-and-node-js.htm
// http://kodemaniak.de/2010/07/cross-domain-ajax-with-restlet-and-jquery/
// http://stackoverflow.com/questions/21783079/ajax-in-chrome-sending-options-instead-of-get-post-put-delete
// http://stackoverflow.com/questions/1256593/why-am-i-getting-an-options-request-instead-of-a-get-request