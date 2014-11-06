var express = require('express')
  , ejs = require('ejs')
  , WebSocket = require('ws')
  , request = require('request')
  , cheerio = require('cheerio')
  , moment = require('moment-timezone')
  , fs = require('fs')
  , nconf = require('nconf')
  , Spreadsheet = require('edit-google-spreadsheet')
  , CronJob = require('cron').CronJob;
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
    'BITCOINADDRESS': '1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp',
    'SPREADSHEET': '',
    'GOAUTHEMAIL': '',
    'PEM_KEY': '',
    'DEBUG': true
});

DEBUG = nconf.get('DEBUG');

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
    this.pendingSpendableCount = 0;
    this.pendingSpendableValue = 0;
    this.pendingUnspendableCount = 0;
    this.pendingUnspendableValue = 0;
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
    this.pendingSpendableCount = 0;
    this.pendingSpendableValue = 0;
    this.pendingUnspendableCount = 0;
    this.pendingUnspendableValue = 0;
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
BitcoinAddress.prototype.addPending = function(spentCount, spentValue, receivedCount, receivedValue) {
    this.pendingSpendableCount += spentCount;
    this.pendingSpendableValue += spentValue;
    this.pendingUnspendableCount += receivedCount;
    this.pendingUnspendableValue += receivedValue;
}
BitcoinAddress.prototype.getApprox = function() {
    return {'spendable': {'value': this.spendableValue - this.pendingSpendableValue,
			  'count': this.spendableCount - this.pendingSpendableCount
			 },
	    'unspendable': {'value': this.unspendableValue + this.pendingUnspendableValue,
			    'count': this.unspendableCount + this.pendingUnspendableCount
			   }
	   }
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

/**
 * Google Spreadsheet setup
 */
var accountingSheet;
var spreadsheetLoad = function(callback) {
    Spreadsheet.load({
	debug: true,
	spreadsheetId: nconf.get('SPREADSHEET'),
	worksheetId: 'od6',

	oauth : {
            email: nconf.get('GOAUTHEMAIL'),
            key: nconf.get('PEM_KEY')
	}

    }, function sheetReady(err, spreadsheet) {
	if (err) {
            throw err;
	}
	accountingSheet = spreadsheet;
	if (callback) {
	    callback();
	}
    });
}
spreadsheetLoad();

var updateSpreadsheet = function(accounting) {
    accountingSheet.receive(function(err, rows, info) {
        if (err) {
            throw err;
        }
    	var nextData = {}
    	nextData[info.nextRow] = [[accounting.date,
				   accounting.tx,
				   accounting.balanceChange,
				   accounting.balance,
				   accounting.baseExchange,
				   accounting.multipltier,
				   accounting.effectiveExchange,
				   accounting.fiat,
				   accounting.fee,
				   accounting.spendable,
				   accounting.unspendable
				  ]];
	if (DEBUG) {
	    console.log(nextData[info.nextRow]);
	}
    	accountingSheet.add(nextData);
    	accountingSheet.send(function(err, rows, info) {
            if (err) {
    		throw err;
            }
    	});
    });
}


var ws_ping_block = JSON.stringify({"op": "ping_block"});
var ws_block_sub = JSON.stringify({"op":"blocks_sub"});
var ws_addr_sub = JSON.stringify({"op":"addr_sub", "addr": bitcoinAddress.getAddress() });
console.log(ws_addr_sub);
var ws_unconfirmed_sub = JSON.stringify({"op":"unconfirmed_sub"});
// var ws = new WebSocket('ws://ws.blockchain.info/inv');
var ws = new WebSocket('ws://ws.blockchain.info:8335/inv');
ws.on('open', function() {
    console.log("Websocket opened");
    ws.send(ws_ping_block);
    ws.send(ws_block_sub);
    ws.send(ws_unconfirmed_sub);
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
	handleNewTransaction(message.x);
    } else {
    	console.log("Unknown!");
    	console.log(message);
    }
});

var handleNewTransaction = function (tx) {
    var message = createMessage(tx);
    if (message) {
	console.log(message);
	smtpTransport.sendMail(message, function(error, response){
    	    if(error){
    		console.log(error);
    	    }else{
    		console.log("Message sent: " + response.message);
    	    }
	});
   }
}

var createMessage = function(tx) {
    var time = moment(tx.time*1000).tz("Asia/Taipei").format();

    var ins = tx.inputs;
    var outs = tx.out;
    var myin = 0;
    var myinval = 0;
    var myout = 0;
    var myoutval = 0;
    var otherout = 0;
    var totalin = 0;
    var totalout = 0;
    for (i in ins) {
	var coin = ins[i].prev_out;
	if (coin.addr == bitcoinAddress.getAddress()) {
	    myin = myin + 1;
	    myinval += coin.value;
	}
	totalin += coin.value;
    }
    for (i in outs) {
	var coin = outs[i];
	if (coin.addr == bitcoinAddress.getAddress()) {
	    myout = myout + 1;
	    myoutval += coin.value;
	} else {
	    otherout += coin.value;
	}
	totalout += coin.value;
    }
    if ((myin == 0) && (myout == 0)) {
	return;  // not our transaction
    }
    if (DEBUG) {
	console.log(tx);
    }
    // was it a pay-in or pay-out?
    var payoutTx = false;  // pay in
    if (myin > 0) {
	payoutTx = true;
    }
    console.log("Payout? "+payoutTx);
    bitcoinAddress.addPending(myin, myinval, myout, myoutval);
    var approx = bitcoinAddress.getApprox();
    console.log("Estimated coins (spend/unspend): ");
    console.log(approx);

    var balanceChange = (myoutval - myinval) / 1e8
    var fiatout = payoutTx ? (Math.round(otherout/1e8*exchangeRate*multiplier/100) * 100) : 0;
    var fee = payoutTx ? ((totalin - totalout) / 1e8) : 0;
    var approxBalance = (approx.spendable.value + approx.unspendable.value) / 1e8;
    var effectiveExchange = multiplier * exchangeRate;
    effectiveExchange = effectiveExchange.toFixed(2);
    var approxBalanceFiat = approxBalance * effectiveExchange;
    approxBalanceFiat = approxBalanceFiat.toFixed(2);
    var accounting = {'date': time,
		      'tx': tx.hash,
		      'balanceChange': balanceChange,
		      'balance': approxBalance,
		      'baseExchange': exchangeRate,
		      'multipltier': multiplier,
		      'effectiveExchange': effectiveExchange,
		      'fiat': fiatout,
		      'spendable': approx.spendable.count,
		      'unspendable': approx.unspendable.count,
		      'fee': fee
		     };
    var doUpdate = function() { updateSpreadsheet(accounting); }
    spreadsheetLoad(doUpdate);

    var subject = "Vending Machine Transaction"

    var html = "<h2>Info</h2><ul><li>Time: "+time+"</li>";
    html += "<li>Transaction: <a href=http://blockchain.info/tx/"+tx.hash+">"+tx.hash+"</a></li>";
    html += "<li>Balance change (BTC): "+balanceChange+"</li>";
    html += "<li>Balance (BTC, approx): "+approxBalance+" (~"+approxBalanceFiat+")</li>";
    html += "<li>Effective exchange rate (TWD/BTC): "+effectiveExchange+"</li>";
    html += "<li>Expected fiat (TWD): "+fiatout+"</li>";
    html += "<li>Coins (spendable/unspendable): "+approx.spendable.count+"/"+approx.unspendable.count+"</li>";
    html += "<li>Miner fee (BTC): "+fee+"</li>";
    html += "</ul>";

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

// Debug restart 1x a day
new CronJob('00 30 9,23 * * *', function(){
  // Restart this process
  process.exit(0);
}, null, true, "Asia/Taipei");
