/****************************************************
*
*	Test Pool Port for Cuckaroo29B / bittube 4
*
*****************************************************/

var config = { 

	poolport: 6000,
	default_job_diff: 1,
	block_difficulty: 4,
	blocktime: 10

};

const net = require("net");
const cuHashing = require('cuckaroo29b-hashing');
const bignum = require('bignum');

function seq(){
	var min = 1000000000;
	var max = 2000000000;
	var id = Math.floor(Math.random() * (max - min + 1)) + min;
	return id.toString();
};

function Log() {}
Log.prototype.log = function (level,message) { console.log(new Date(Date.now()).toISOString()+' ['+level+'] '+message); }
Log.prototype.info  = function (message) {this.log('info',message);}
Log.prototype.error = function (message) {this.log('error',message);}
Log.prototype.debug = function (message) {/*this.log('debug',message);*/}
const logger = new Log();

process.on("uncaughtException", function(error) {
	logger.error(error);
});


var current_target    = 0;
var current_height    = 0;
var current_hashblob  = "";
var previous_hashblob = "";
var connectedMiners   = {};

function nonceCheck(miner,nonce) {

	if (miner.nonces.indexOf(nonce) !== -1) return false;

	miner.nonces.push(nonce);

	return true;
}

function hashrate(miner) {

	miner.shares += miner.difficulty|0;

	var hr = miner.shares*40/((Date.now()/1000|0)-miner.begin);

	return 'rig:'+miner.pass+' '+hr.toFixed(2)+' gps';

}

function updateJob(reason,callback){

	current_target = config.block_difficulty;
	previous_hashblob = current_hashblob;
	current_hashblob = "070786a498d705f8dc58791266179087907a2ff4cd883615216749b97d2f12173171c725a6f84a00000000fc751ea4a94c2f840751eaa36138eee66dda15ef554e7d6594395827994e"+("000000"+(Math.floor(Math.random()*16777215).toString(16))).substr(-6);
	current_height=current_height+1;

	logger.info('New block to mine at height '+current_height+' w/ difficulty of '+current_target+' (triggered by: '+reason+')');

	for (var minerId in connectedMiners){
		var miner = connectedMiners[minerId];
		miner.nonces = [];
		var response2 = '{"id":"Stratum","jsonrpc":"2.0","method":"getjobtemplate","result":{"difficulty":'+miner.difficulty+',"height":'+current_height+',"job_id":'+parseFloat(seq())+',"pre_pow":"'+ current_hashblob +'"},"error":null}';
		miner.socket.write(response2+"\n");
	}
	
	if(callback) callback();
}

function Miner(id,socket){
	this.socket = socket;
	this.login = '';
	this.pass = '';
	this.begin = Date.now()/1000|0;
	this.shares = 0;
	this.difficulty = 1;
	this.id = id;
	this.nonces = [];
	
	var client = this;
	
	socket.on('data', function(input) {
		try{
			for (var data of input.toString().trim().split("\n"))
				handleClient(data,client);
		}
		catch(e){
			logger.error("error: "+e+" on data: "+input);
			socket.end();
		}
	});
	
	socket.on('close', function(had_error) {
		logger.info('miner connction dropped '+client.login);
		delete connectedMiners[client.id];
		socket.end();
	});

	socket.on('error', function(had_error) {
		socket.end();
	});
}
Miner.prototype.respose = function (result,error,request) {
	
	var response = JSON.stringify({
			id:request.id.toString(),
			jsonrpc:"2.0",
			method:request.method,
			result: (result?result:null),
			error: (error?error:null)
	});
	logger.debug("p->m "+response);
	this.socket.write(response+"\n");
}
	
function handleClient(data,miner){
	
	logger.debug("m->p "+data);

	var request = JSON.parse(data.replace(/([0-9]{15,30})/g, '"$1"'));//puts all long numbers in quotes, js can't handle 64bit ints

	var response;

	if(request && request.method && request.method == "login") {

		miner.login=request.params.login;
		miner.pass =request.params.pass;
		var fixedDiff = miner.login.indexOf('.');
		if(fixedDiff != -1) {
			miner.difficulty = miner.login.substr(fixedDiff + 1);
			if(miner.difficulty < 1) miner.difficulty = config.default_job_diff;
			if(isNaN(miner.difficulty)) miner.difficulty = config.default_job_diff;
			miner.login = miner.login.substr(0, fixedDiff);
		}
		logger.info('miner connect '+request.params.login+' ('+request.params.agent+') ('+miner.difficulty+')');
		return miner.respose('ok',null,request);
	}
	
	else if(request && request.method && request.method == "submit") {

		if(!request.params || !request.params.job_id || !request.params.pow || !request.params.nonce || request.params.pow.length != 40) {

			logger.info('bad data ('+miner.login+')');
			return miner.respose(null,{code: -32502, message: "wrong hash"},request);
		}
		
		if(! nonceCheck(miner,request.params.pow.join('.'))) {
		
			logger.info('duplicate ('+miner.login+')');
			return miner.respose(null,{code: -32503, message: "duplicate"},request);
		}
		
		var noncebuffer = Buffer.allocUnsafe(4);
		noncebuffer.writeUInt32BE(request.params.nonce,0);
		var header = Buffer.concat([Buffer.from(current_hashblob, 'hex'),noncebuffer]);
		
		var prooferror = cuHashing.cuckaroo29b(header,request.params.pow);
		
		if(prooferror){

			var header_previous = Buffer.concat([Buffer.from(previous_hashblob, 'hex'),noncebuffer]);
		
			var prooferror2 = cuHashing.cuckaroo29b(header_previous,request.params.pow);
			
			if(! prooferror2){

				logger.info('stale ('+miner.login+')');
				return miner.respose('stale',null,request);
			}
			else{

				logger.info('wrong hash or very old ('+miner.login+') '+request.params.height);
				return miner.respose(null,{code: -32502, message: "wrong hash"},request);
			}
		}
	
		var hashDiff = bignum(cuHashing.getdifficultyfromhash(cuHashing.cycle_hash(request.params.pow)));
		
		if (hashDiff.ge(current_target)){

			logger.info('BLOCK ('+miner.login+') '+hashDiff+'/'+miner.difficulty+' ('+hashrate(miner)+')');
			miner.respose('ok',null,request);
			updateJob('found block');
			return;
		}
		else if (hashDiff.ge(miner.difficulty)){
				
			logger.info('share ('+miner.login+') '+hashDiff+'/'+miner.difficulty+' ('+hashrate(miner)+')');
			return miner.respose('ok',null,request);
		}
		else{

			logger.info('low diff ('+miner.login+') '+miner.difficulty);
			return miner.respose(null,{code: -32501, message: "low diff"},request);
		}
		
	}
	
	else if(request && request.method && request.method == "getjobtemplate") {
		
		return miner.respose({difficulty:parseFloat(miner.difficulty),height:current_height,job_id:parseFloat(seq()),pre_pow:current_hashblob},null,request);
	}
	else{

		logger.info("unkonwn method: "+request.method);
	}

}

var server = net.createServer(function (localsocket) {

	var minerId = seq();
	var miner = new Miner(minerId,localsocket);
	connectedMiners[minerId] = miner;
});
server.timeout = 0;


updateJob('init',function(){

	server.listen(config.poolport);
	logger.info("start test pool, port "+config.poolport);

});


setInterval(function(){updateJob('timer');}, config.blocktime * 1000);

