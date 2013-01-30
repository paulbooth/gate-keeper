/**
 * Module dependencies.
 */

var express = require('express')
  , http = require('http')
  , https = require('https')
  , mongo = require('mongodb')
  , Db = mongo.Db
  , path = require('path');

var app = express();
var hostUrl = 'http://fb-gate-keeper.herokuapp.com'

var db; // Database opened later

app.configure(function(){
  app.set('port', process.env.PORT || 3000);
  app.set('dburl', process.env.MONGOLAB_URI || 'mongodb://localhost:27017/forcexercise');
  app.set('views', __dirname + '/views');
  app.set('view engine', 'jade');
  app.use(express.favicon());
  app.use(express.logger('dev'));
  app.use(express.bodyParser());
  app.use(express.cookieParser());
  app.use(express.cookieSession({
    secret: 'fb-gate-keeper'
  }));
  app.use(express.methodOverride());
  app.use(app.router);
  app.use('/public', express.static(path.join(__dirname, 'public')));
});

app.configure('development', function(){
  app.use(express.errorHandler());
});

app.get('/:fbapp/admin', function(req, res) {
  getAllFbUsers(req.params.fbapp, function(dbitems) {
    var fbusers = dbitems.map(function(dbitem) { return dbitem.fbuser; });
    console.log(JSON.stringify(fbusers, undefined, 2));
    res.render('namespace', {namespace:req.params.fbapp, fbusers: fbusers});
  });
});

app.post('/:fbapp/keys/:apikey/:secretkey/:perms/:callback', function(req, res) {
  setApiKeys(req.params.fbapp, req.params.apikey, req.params.secretkey, req.params.perms, decodeURIComponent(req.params.callback), function() {
    res.send('okay.');
  });
});

app.get('/:fbapp/user/:deviceid', function(req, res) {
  console.log('retrieving id ' + req.params.deviceid + ' from app ' + req.params.fbapp);
  getFbUser(req.params.fbapp, req.params.deviceid, function(item) {
    if (item != null) {
      res.json(item.fbuser);
    } else {
      setFbUser(req.params.fbapp, req.params.deviceid, null, function() {
        res.json({error:"Device ID not associated with Facebook user."});
      })
    }
  });
});


// First part of Facebook auth dance.
app.get('/:fbapp/login', function (req, res){
  getApiKey(req.params.fbapp, function(apikeyobj) {
    console.log(apikeyobj);
    var redirect_url = 'https://www.facebook.com/dialog/oauth?client_id=' + apikeyobj.api_key +
     '&redirect_uri=' + hostUrl + '/' + req.params.fbapp + '/perms' +
     '&scope=' + apikeyobj.permissions + '&state=authed'
    // console.log("REDIRECTIN' From /")
    // console.log(redirect_url);
    // console.log("REQUEST HEADERS:" + JSON.stringify(req.headers));
    res.redirect(redirect_url);
  });
});

// Response from Facebook with user permissions.
app.get('/:fbapp/perms', function (req, res){
  getApiKey(req.params.fbapp, function(apikeyobj) {
    var state = req.query['state'];
    var code = req.query['code'];
    // console.log("req.query:" + JSON.stringify(req.query))
    // console.log("hit " + req.params.fbapp + "/perms")
    // console.log("Code:");
    // console.log(code);
    if (state == 'authed') {
      console.log('sick. Facebook PERMED us on ' + req.params.fbapp + '.')
      var redirect_path = '/oauth/access_token?' +
        'client_id=' + apikeyobj.api_key +
        '&redirect_uri=' + hostUrl + '/' + req.params.fbapp + '/perms' +
        '&client_secret=' + apikeyobj.secret_key +
        '&code=' + code;// + '&destination=chat';
      var options = {
        host: 'graph.facebook.com',
        port: 443,
        path: redirect_path
      };

      https.get(options, function(fbres) {
        // console.log('STATUS: ' + fbres.statusCode);
        // console.log('HEADERS: ' + JSON.stringify(fbres.headers));
        var output = '';
        fbres.on('data', function (chunk) {
            output += chunk;
        });

        fbres.on('end', function() {
          console.log("ACCESS TOKEN RIGHT HERE FOR " + req.params.fbapp);
          console.log(output);
          // parse the text to get the access token
          req.session.access_token = output.replace(/access_token=/,"").replace(/&expires=\d+$/, "");
          req.session.fbapp = req.params.fbapp;

          // console.log("ACCESS TOKEN:" + access_token)
          res.redirect('/' + req.params.fbapp + '/basicinfo');
        });
      }).on('error', function(e) {
        console.log('ERROR: ' + e.message);
        console.log(redirect_path);
        console.log(JSON.stringify(e, undefined, 2))
      });
    } else {
      console.error("WHAT THE HECK WE AREN'T AUTHED %s?????? %s", req.params.fbapp, state);
    }
  });
});

// Requests user info for the user, then redirects to the landing page.
app.get('/:fbapp/basicinfo', function(req, res) {
  if (!req.session.access_token) {
    console.log("NO " + req.params.fbapp + " ACCESS TOKEN AT Basic info.")
    res.redirect('/' + req.params.fbapp + '/login'); // go home to start the auth process again
    return;
  }
  if (req.params.fbapp != req.session.fbapp) {
    console.log("The session has an access token for app %s when the url requested is app %s.", req.session.fbapp, req.params.fbapp);
    res.redirect('/' + req.params.fbapp + '/login');
    return;
  }
  var options = {
      host: 'graph.facebook.com',
      port: 443,
      path: '/me?access_token=' + req.session.access_token
    };
  https.get(options, function(fbres) {
      var output = '';
      fbres.on('data', function (chunk) {
          //console.log("CHUNK:" + chunk);
          output += chunk;
      });

      fbres.on('end', function() {
        console.log("%s/basicinfo output:", req.params.fbapp);
        console.log(output);
        req.session.user = getReducedUser(JSON.parse(output), req.session.access_token);
        console.log(JSON.stringify(req.session.user, undefined, 2));
        res.redirect('/' + req.params.fbapp + '/setupdevice');
      });
  });
});

// I don't think this will work because the session variable is set on the browser when
// the user is logging into the app, which will not be present when a server or hardware
// queries this endpoint. I added the access_token as a field in the fbuser object. -Paul
app.get('/:fbapp/:userFacebookID/token', function(req, res) {
  if (!req.session.access_token) {
    res.send( {'error' : 'No Access Token Stored in GateKeeper'});
  } else {
    res.send( {'access_token' : req.session.access_token});
  }
});

app.get('/:fbapp/setupdevice', function(req, res) {
  if (!req.session.access_token) {
    console.log("NO " + req.params.fbapp + " ACCESS TOKEN AT setupdevice.")
    res.redirect('/' + req.params.fbapp + '/login'); // go home to start the auth process again
    return;
  }
  if (req.params.fbapp != req.session.fbapp) {
    console.log("The session has an access token for app %s when the url requested is app %s.", req.session.fbapp, req.params.fbapp);
    res.redirect('/' + req.params.fbapp + '/login');
    return;
  }
  if (!req.session.user) {
    console.log("NO " + req.params.fbapp + " USER AT setupdevice.")
    res.redirect('/' + req.params.fbapp + '/login'); // go home to start the auth process again
    return;
  }
  getUnclaimedDeviceIds(req.params.fbapp, function(deviceIds) {
    res.render('setupdevice.jade', {namespace: req.params.fbapp, deviceIds: deviceIds});
  });  
});

app.get('/:fbapp/sync/:deviceid', function(req, res) {
  if (!req.session.access_token) {
    console.log("NO " + req.params.fbapp + " ACCESS TOKEN AT Basic info.")
    res.redirect('/' + req.params.fbapp + '/login'); // go home to start the auth process again
    return;
  }
  if (req.params.fbapp != req.session.fbapp) {
    console.log("The session has an access token for app %s when the url requested is app %s.", req.session.fbapp, req.params.fbapp);
    res.redirect('/' + req.params.fbapp + '/login');
    return;
  }
  setFbUser(req.params.fbapp, req.params.deviceid, req.session.user, function() {
    getApiKey(req.params.fbapp, function(apikeyobj) {
      res.redirect(apikeyobj.callback_url);
    });
  });
});

// Allows the user to log out of our system.
app.get('/:fbapp/logout', function(req, res) {
  if (!req.session.access_token) {
    res.redirect('/' + req.params.fbapp + '/login');
    return;
  }
  var fbLogoutUri = 'https://www.facebook.com/logout.php?next=' + hostUrl + '/' + req.params.fbapp + '/login&access_token=' + req.session.access_token
  req.session.user = null;
  req.session.access_token = null;
  req.session.fbapp = null;
  res.redirect(fbLogoutUri);
});



// Start database and get things running
console.log("connecting to database at " + app.get('dburl'));
Db.connect(app.get('dburl'), {}, function (err, _db) {
  // Escape our closure.
  db = _db;

  // Define some errors.
  db.on("error", function(error){
    console.log("Error connecting to MongoLab.");
    console.log(error);
  });
  console.log("Connected to mongo.");

  // Start server.
  http.createServer(app).listen(app.get('port'), function(){
    console.log("Express server listening on port " + app.get('port'));
  });
});

/* Database opoerations */


function setFbUser (namespace, deviceid, fbuser, callback) {
  db.collection(namespace, function(err, collection) {
    collection.update({'deviceid': deviceid}, {
      'deviceid': deviceid,
      'fbuser': fbuser
    }, {safe: true, upsert: true}, callback);
  });
}

function getFbUser(namespace, deviceid, callback) {
  db.collection(namespace, function (err, collection) {
    collection.findOne({
      'deviceid': deviceid,
    }, function(err, item) {
        callback(item);
    });
  });
}

function getUnclaimedDeviceIds(namespace, callback) {
  db.collection(namespace, function (err, collection) {
    collection.find({'fbuser': null}, function (err, cursor) {
      cursor.toArray(function(err, items) {
        callback(items);
      });
    });
  });
}

function getAllFbUsers(namespace, callback) {
  db.collection(namespace, function (err, collection) {
    collection.find({}, function (err, cursor) {
      cursor.toArray(function(err, items) {
        callback(items);
      });
    });
  });
}


function getApiKey(namespace, callback) {
  db.collection('api_keys', function (err, collection) {
    collection.findOne({
      'namespace': namespace,
    }, function(err, item) {
        callback(item);
    });
  });
}

function setApiKeys (namespace, apiKey, secretKey, permissions, callbackUrl, callback) {
  console.log('setting api keys');
  db.collection('api_keys', function(err, collection) {
    collection.update({'namespace': namespace}, {
      'namespace': namespace,
      'api_key': apiKey,
      'secret_key': secretKey,
      'permissions': permissions,
      'callback_url': callbackUrl
    }, {safe: true, upsert: true}, callback);
  });
}

/* Utilities */


// Returns a user object that only has the elements that we care about from the user
// This solves the problem of cookies being too big to store
function getReducedUser(user, access_token) {
  return {id: user.id, name: user.name, first_name: user.first_name, last_name: user.last_name, link: user.link, username: user.username, access_token: access_token};
}