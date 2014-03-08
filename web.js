var express = require('express')
  , ejs = require('ejs')
  , WebSocket = require('ws')
  , request = require('request')
  , cheerio = require('cheerio')
  , moment = require('moment-timezone')
;

// Email settings
var nodemailer = require("nodemailer");
// create reusable transport method (opens pool of SMTP connections)
var smtpTransport = nodemailer.createTransport("SMTP",{
    host: process.env.SMTPSERVER,
    port: process.env.SMTPPORT,
    auth: {
        user: process.env.SMTPUSER,
        pass: process.env.SMTPPASS
    }
});

var multiplier = 1.03;
var exchangeRate = 0;
/**
 * Update gloabal exchange rate from BitPay
 */
var updateExchangeRate = function() {
    var ratesApiUrl = "https://bitpay.com/api/rates";
    request(ratesApiUrl, function (error, response, body) {
	if (!error && response.statusCode == 200) {
	    var ratesResponse = JSON.parse(body);
	    for (index in ratesResponse) {
		var currency = ratesResponse[index];
		if (currency.code === "TWD") {
		    exchangeRate = currency.rate;
		    return false;
		};
	    };
	};
    });
};
updateExchangeRate();
setInterval(updateExchangeRate, 10*60*1000); // run every 10 minutes

var ws_ping_block = JSON.stringify({"op": "ping_block"});
var ws_addr_sub = JSON.stringify({"op":"addr_sub", "addr": process.env.MONITOR });
console.log(ws_addr_sub);
var ws_unconfirmed_sub = JSON.stringify({"op":"unconfirmed_sub"});
// var ws = new WebSocket('ws://ws.blockchain.info/inv');
var ws = new WebSocket('ws://ws.blockchain.info:8335/inv');
ws.on('open', function() {
    console.log("Websocket opened");
    ws.send(ws_ping_block);
    ws.send(ws_addr_sub);
    // ws.send(ws_unconfirmed_sub);
});

var doPing = function() {
    ws.ping();
};
setInterval(doPing, 2.5*60*1000); // send a ping every 2.5 minutes, try to keep websocket alive
ws.on('pong', function(data, flags) {
    console.log("PONG!");
});

ws.on('message', function(data, flags) {
    try {
	var message = JSON.parse(data);
    } catch (e) {
	console.log(e);
	return;
    }
    if (message.op === "block") {
	console.log("Got a block! Height: "+message.x.height);
    } else if (message.op === "utx") {
	console.log('Got new transaction!');
	handleNewTransaction(message.x);
    } else {
	console.log("Unknown!");
	console.log(message);
    }
});

var handleNewTransaction = function (tx) {
    var message = createMessage(tx);
    console.log(message);
    smtpTransport.sendMail(message, function(error, response){
	if(error){
	    console.log(error);
	}else{
	    console.log("Message sent: " + response.message);
	}
    });
}

var createMessage = function(tx) {
    var subject = "Monitored Transaction"

    var time = moment(tx.time*1000).tz("Asia/Taipei").format();

    var html = "<h2>Info</h2><ul><li>Time: "+time+"</li></ul>";
    html = html + "<h2>Outputs:</h2><ol>";
    
    var outs = tx.out;
    for (var index = 0; index < outs.length; index++) {
	out = outs[index];
	var addr = out.addr
          , valueBTC = out.value/1e8;
	var valueFiat = "?";
	var financeLog = '';
	if (exchangeRate > 0) {
	    valueFiat = valueBTC * exchangeRate * multiplier;
	    valueFiat = valueFiat.toFixed(2);  // truncate to cents
	    financeLog = "TWD/BTC: "+exchangeRate;
	    total = exchangeRate*multiplier;
	    total = total.toFixed(4);  // truncate to 4 digits, as done on BitPay
	    financeLog = financeLog + "<br>Total probable displayed exchange rate TWD/BTC: " + total;
	}
	html = html + "<li><strong>"+addr+"</strong>: "+valueBTC+" BTC ("+valueFiat+" TWD)</li>";
    }
    html = html + "</ol><br>(using multiplier "+multiplier+")<br>"+financeLog;

    var mailOptions = {
    	from: process.env.MAILFROM,
    	to: process.env.MAILTO,
    	subject: subject,
    	html: html
    }
    return mailOptions;
}

var app = express()
  , http = require('http')
  , server = http.createServer(app)
;

app.set('views',__dirname + '/views');
app.set('view engine', 'ejs');
app.locals({
  _layoutFile: false
});

app.use(express.logger());
app.use(express.static('public'));
app.use(express.bodyParser());
app.use(express.cookieParser());
app.use(express.session({secret: process.env.SESSION_SECRET || 'akjsfkjs345$%VFDVGT%'}));
app.use(express.errorHandler());

app.get('/', function(request, response) {
    response.send('OK!');
});

var port = process.env.PORT || 3000;
server.listen(port, function() {
  console.log("Listening on " + port);
});

