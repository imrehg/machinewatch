var express = require('express')
  , ejs = require('ejs')
  , WebSocket = require('ws')
  , request = require('request')
  , cheerio = require('cheerio')
  , moment = require('moment-timezone')
  , fs = require('fs')
  , nconf = require('nconf')
;

// Load configuration
nconf.argv()
    .env()
    .file({ file: 'config.json' });

nconf.defaults({
    'SMTPSERVER': '',
    'SMTPPORT': 0,
    'SMTPUSER': '',
    'SMTPPASS': '',
    'MAILFROM': '',
    'MAILTO': '',
    'MULTIPLIER': 1.0,
    'BITCOINADDRESS': '1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp'
});

// Email settings
var nodemailer = require("nodemailer");
// create reusable transport method (opens pool of SMTP connections)
var smtpTransport = nodemailer.createTransport("SMTP",{
    host: nconf.get('SMTPSERVER'),
    port: nconf.get('SMTPPORT'),
    auth: {
        user: nconf.get('SMTPUSER'),
        pass: nconf.get('SMTPPASS')
    }
});

multiplier = nconf.get('MULTIPLIER');
exchangeRate = 0;
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
setInterval(updateExchangeRate, 1*60*1000); // run every 1 minute

function BitcoinAddress(address) {
    this.address = address;
    this.coins = [];
    this.spendableCount = 0;
    this.spendableValue = 0;
    this.unspendableCount = 0;
    this.unspendableValue = 0;
}
BitcoinAddress.prototype.getCoinValue = function () {
    return {'spendable': this.spendableValue, 'unspendable': this.unspendableValue};
};
BitcoinAddress.prototype.setCoins = function(coins) {
    this.coins = coins;
    this.spendableCount = 0;
    this.spendableValue = 0;
    this.unspendableCount = 0;
    this.unspendableValue = 0;
    for (i in this.coins) {
	var coin = this.coins[i];
	if (coin.confirmations > 1) {
	    this.spendableValue += coin.value;
	    this.spendableCount += 1;
	} else {
	    this.unspendableValue += coin.value;
	    this.unspendableCount += 1;
	}
    };
}
BitcoinAddress.prototype.getCoinsNum = function() {
    return this.coins.length;
}
BitcoinAddress.prototype.getAddress = function() {
    return this.address;
}
BitcoinAddress.prototype.getSpendable = function() {
    return {'value': this.spendableValue, 'count': this.spendableCount};
}
BitcoinAddress.prototype.getUnspendable = function() {
    return {'value': this.unspendableValue, 'count': this.unspendableCount};
}


bitcoinAddress = new BitcoinAddress(nconf.get('BITCOINADDRESS'));

var getUnspent = function(address) {
    var url = "http://blockchain.info/unspent?active="+address.getAddress();
    request(url, function(error, response, body) {
	if (!error && response.statusCode == 200) {
	    var unspent = JSON.parse(body).unspent_outputs;
	    address.setCoins(unspent);
	}
	console.log('Total unspent for '+address.getAddress()+': '+address.getCoinsNum());
	console.log(address.getSpendable());
	console.log(address.getUnspendable());
    });
}

var ws_ping_block = JSON.stringify({"op": "ping_block"});
var ws_addr_sub = JSON.stringify({"op":"addr_sub", "addr": bitcoinAddress.getAddress() });
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
	getUnspent(bitcoinAddress);
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

    var ins = tx.inputs;
    var outs = tx.out;
    var myin = 0;
    var myout = 0;
    for (i in ins) {
	var coin = ins[i].prev_out;
	if (coin.addr == bitcoinAddress) {
	    myin = myin + 1;
	}
    }
    for (i in outs) {
	var coin = outs[i];
	if (coin.addr == bitcoinAddress) {
	    myout = myout + 1;
	}
    }
    console.log('Destroyed own coins: '+myin);
    console.log('Received own coins: '+myout);
    // was it a pay-in or pay-out?
    var payoutTx = false;  // pay in
    if (myin > 0) {
	payoutTx = true;
    }
    console.log("Payout? "+payoutTx);
    var spendable = bitcoinAddress.getSpendable().count - myin;
    var unspendable = bitcoinAddress.getUnspendable().count + myout;
    console.log("Estimated coins (spend/unspend): "+spendable+"/"+unspendable);

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
    	from: nconf.get('MAILFROM'),
    	to: nconf.get('MAILTO'),
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
app.use(express.session({secret: nconf.get('SESSION_SECRET') || 'akjsfkjs345$%VFDVGT%'}));
app.use(express.errorHandler());

app.get('/', function(request, response) {
    response.send('OK!');
});

var port = process.env.PORT || 3000;
server.listen(port, function() {
  console.log("Listening on " + port);
});

