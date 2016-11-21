'use strict';

const myasync = require('myasync');
const moment = require('moment');
const redis = require('redis');

const COMPUTE_DAYS = 30;//计算30天的数据
const EXPORT_DAYS = 10; //导出10天的数据

function StatTable(options) {
  let host = options.host;
  let port = options.port;
  let db   = options.db;

  if (!(host && port && db)) {
    console.log('host, port and db are required in options');
    return;
  }

  let client = redis.createClient({host, port, db});
  client.on('error', (err) => {
    console.log(`redis connect error: ${host} ${port} ${db}`, err);
  });
  client.on('ready', (err) => {
    console.log(`redis client ready: ${host} ${port} ${db}`);
  });

  this.client = client;
}

module.exports = StatTable;

const redisKey = {
  register: (date) => { return `r:${date}`; },
  login: (date) => { return `l:${date}`; },
  retention: (date, count) => { return `rt:${date}:${count}`; },
};

function formatDate() {
  return moment().format('YYYYMMDD');
}

StatTable.prototype.addToZset = function(key, score, member, cb) {
  this.client.zadd(key, score, member, cb);
};

StatTable.prototype.recordRegister = function(uid, cb) {
  cb = cb || _.noop;
  let date = formatDate();
  this.addToZset(redisKey.register(date), 1, uid.toString(), cb);
};

StatTable.prototype.recordLogin = function(uid, cb) {
  cb = cb || _.noop;
  let date = formatDate();
  this.addToZset(redisKey.login(date), 1, uid.toString(), cb);
};

StatTable.prototype.buildRetention = (processDate, baseDate, count, cb) => {
  let registerKey  = redisKey.register(baseDate);//r:20161118
  let loginKey     = redisKey.login(processDate);//r:20161119
  let retentionKey = redisKey.retention(baseDate, count);//rt:20161118:1
  this.client.zinterstore(retentionKey, 2, registerKey, loginKey, cb);
};

StatTable.prototype.getRetention = (baseDate, count, cb) => {
  let commands = [['zcard', redisKey.register(baseDate)]];
  for (let i = 1; i <= count; i++) {
    commands.push(['zcard', redisKey.retention(baseDate, i)]);
  }
  this.client.multi(commands).exec(cb);
};

StatTable.prototype.buildRetentions = function(processDate, cb) {
  if (typeof processDate === 'function') {
    cb = processDate;
    processDate = moment().format('YYYYMMDD');
  } else {
    if (moment(processDate, 'YYYYMMDD').isValid()) {
      processDate = moment(processDate, 'YYYYMMDD').format('YYYYMMDD');
    } else {
      console.log('date format must be [YYYYMMDD]');
      return cb(new Error('DateFormatErr'));
    }
  }
  let self = this;
  let count = 0;
  async.whilst(
    function () { return count < COMPUTE_DAYS; },
    function (_cb) {
      count++;
      let baseDate = moment(processDate, 'YYYYMMDD')
                        .subtract(count, 'd')
                        .format('YYYYMMDD');
      console.log(processDate, baseDate, count);
      self.buildRetention(processDate, baseDate, count, _cb);
    },
    cb
  );
};

StatTable.prototype.buildRetentionTable = function(cb) {
  let results = [];
  let count = 0;
  let self = this;
  async.whilst(
    function () { return count <= EXPORT_DAYS; },
    function (_cb) {
      let baseDate = moment().subtract(count, 'd').format('YYYYMMDD');
      console.log(baseDate, count);
      self.buildOneLine(baseDate, count, (err, nums) => {
        if (err) return _cb(err);
        count++;
        results.unshift(nums);
        _cb();
      });
    },
    (err) => {
      if (err) return cb(err);
      cb(null, results);
    }
  );
};

StatTable.prototype.exportRetention = function(cb) {
  cb = cb || _.noop;
  let self = this;
  myasync.mySeries({
    results: (_cb, ret) => {
      self.buildRetentionTable(_cb);
    },
    csvStr: (_cb, ret) => {
      console.log('stringify now...');
      ret.results.unshift(csvFirstLine());
      csv.stringify(ret.results, _cb);
    },
    writeFile: (_cb, ret) => {
      let path = `./public/exportRetention${formatDate()}.csv`;
      fs.writeFile(path, ret.csvStr, 'utf-8', _cb);
    },
  }, cb);
};

StatTable.prototype.buildOneLine = function(date, count, cb) {
  this.getRetention(date, count, (err, nums) => {
    if (err) return cb(err);
    nums.unshift(date);
    cb(null, nums);
  });
};

function csvFirstLine() {
  return ['date', 'registerNum'].concat(
    _.map(_.range(1, EXPORT_DAYS + 1), function(num) {
      return `${num}day`;
    })
  );
}
