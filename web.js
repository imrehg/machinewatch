var express = require('express')
  , ejs = require('ejs')
  , WebSocket = require('ws');
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

var ws_ping_block = JSON.stringify({"op": "ping_block"});
var ws_addr_sub = JSON.stringify({"op":"addr_sub", "addr": process.env.MONITOR });
var ws_unconfirmed_sub = JSON.stringify({"op":"unconfirmed_sub"});

var ws = new WebSocket('ws://ws.blockchain.info/inv');
ws.on('open', function() {
    console.log("Websocket opened");
    ws.send(ws_ping_block);
    ws.send(ws_addr_sub);
    // ws.send(ws_unconfirmed_sub);
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
	console.log(message);
    } else if (message.op === "utx") {
	handleNewTransaction(message.x);
    } else {
	console.log("Unknown!");
	console.log(message);
    }
});

var handleNewTransaction = function (tx) {
    console.log(tx.hash);
    console.log(tx.time);
    console.log(tx.out);
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
    var html = "<h2>Outputs:</h2><ol>";
    
    var outs = tx.out;
    for (var index = 0; index < outs.length; index++) {
	out = outs[index];
	html = html + "<li><strong>"+out.addr+"</strong>: "+out.value/1e8+" BTC</li>";
    }
    html = html + "</ol>";

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

// app.post('/transaction', function(request, response) {
//     var id = request.query.id;
//     console.log(id);
//     Venue.findOne({ token: id }, function(err, obj) {
// 	if (obj) {
// 	    var transaction = request.body;
// 	    if (transaction.order) {
// 		var order = transaction.order;
// 		var btc = order.total_btc.cents / 1e8;
// 		var fiat = order.total_native.cents / 100;
// 		var fiatcode = order.total_native.currency_iso;
// 		var id = order.id;

// 		var message = createMessage(btc, fiat, fiatcode, id, obj);
// 		console.log(message);
// 		smtpTransport.sendMail(message, function(error, response){
// 		    if(error){
// 			console.log(error);
// 		    }else{
// 			console.log("Message sent: " + response.message);
// 		    }
// 		});
// 	    }
// 	    response.send('ok!');
// 	} else {
// 	    response.status(401).send('Not authorized');
// 	}
//     });
// });

var port = process.env.PORT || 3000;
server.listen(port, function() {
  console.log("Listening on " + port);
});
