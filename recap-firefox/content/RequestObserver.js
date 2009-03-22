
/** RequestObserver:
 *    implements nsIObserver
 *
 *    Receives notifications for all http-on-examine-response events.
 *    Upon notification, if this is a PACER document:
 *      - Modifies the HTTP response headers to be cache-friendly
 *      - If necessary, modifies the default filename to be save-friendly
 *      - If "uploadworthy", uploads the file to a server
 *
 */

function RequestObserver() {
    this._register();
}

RequestObserver.prototype = {

    // Logs interesting HTTP response headers to the Error Console
    logHeaders: function(channel) {
	var headers = ["Age", "Cache-Control", "ETag", "Pragma", 
		       "Vary", "Last-Modified", "Expires", "Date", 
		       "Content-Disposition", "Content-Type"];

	var output = "Headers for " + channel.URI.asciiSpec + "\n  ";
	for (var i = 0; i < headers.length; i++) {
	    var hvalue = "";
	    try {
		hvalue = channel.getResponseHeader(headers[i]);
	    } catch(e) {
		hvalue = "<<none>>";
	    }

	    output += "'" + headers[i] + "': " + "'" + hvalue + "'; ";
	}

	log(output);
    },

    // Set the HTTP response headers to be cache-friendly
    setCacheFriendlyHeaders: function(channel) {

	var pragmaVal = this.getPragmaValue(channel);

        var prefs = CCGS("@mozilla.org/preferences-service;1",
			 "nsIPrefService").getBranch("recap.");
        
        var cache_time_ms = prefs.getIntPref("cache_time_ms");
        //log("cache_time_ms = " + cache_time_ms);

        var expireTime = (new Date()).getTime() + cache_time_ms;
        var expiresVal = (new Date(expireTime)).toUTCString();

	//var expiresVal = (new Date(oneday)).toUTCString();
	var dateVal = (new Date()).toUTCString();

	channel.setResponseHeader("Age", "", false);
	channel.setResponseHeader("Cache-Control", "", false);
	channel.setResponseHeader("ETag", "", false);
	channel.setResponseHeader("Pragma", pragmaVal, false);
	channel.setResponseHeader("Vary", "", false);
	channel.setResponseHeader("Last-Modified", "", false);
	channel.setResponseHeader("Expires", expiresVal, false);
	channel.setResponseHeader("Date", dateVal, false);

    },

    // Removes 'no-cache' from the Pragma response header if it exists
    getPragmaValue: function(channel) {
	try {
	    var hpragma = channel.getResponseHeader("Pragma");
	} catch(e) {
	    return "";
	}
	
	return hpragma.replace(/no-cache/g, "");
    },

    // Sets a better filename in the Content-Disposition header
    setContentDispositionHeader: function(channel, filename, court) {

	if (filename != null && court != null) {

	    var cdVal = "inline; filename=\"" + PACER_TO_WEST_COURT[court] + 
	                 "-" + filename + "\"";	

	    log("Setting Content-Disposition to: " + cdVal);
	    channel.setResponseHeader("Content-Disposition", cdVal, false);
	}

    },

    // Gets the PDF metadata from the referrer URI
    getPDFmeta: function(channel, mimetype) {

	var referrer = channel.referrer;

	try {
	    var refhost = referrer.asciiHost;
	    var refpath = referrer.path;	   
	} catch(e) {
	    return {mimetype: mimetype, court: null, 
		    url: null, name: null};
	}

	var court = getCourtFromHost(refhost);
	
	var pathSplit = refpath.split("/");

	// filename will be the last segment of the path, append file suffix
	var filename = pathSplit.pop() + this.fileSuffixFromMime(mimetype);

	return {mimetype: mimetype, court: court, 
		name: filename, url: refpath };
    },

    // If this is an interesting HTML page generated by a PACER Perl script,
    //   return the page's metadata.  Otherwise, return false.
    tryPerlHTMLmeta: function(channel, path, mimetype) {

	var downloadablePages = ["HistDocQry.pl", "DktRpt.pl"];
	    
	var referrer = channel.referrer;
	try {
	    var refhost = referrer.asciiHost;
	    var refpath = referrer.path;	   
	} catch(e) {
	    return false;
	}

	var pageName = this.perlPathMatch(path);
	var refPageName = this.perlPathMatch(refpath);
	
	// HTML page is only interesting if 
	//    (1) it is on our list, and
	//    (2) the page name is the same as the referrer's page name.
	//   i.e. we want to upload the docket results HTML page
	//         and not the docket search form page.
	// SS: I think we could do #2 more intelligently by looking at POST vars
	// HY:  We would need to monitor outbound requests
	if (pageName && refPageName &&
	    pageName == refPageName &&
	    downloadablePages.indexOf(pageName) >= 0) {

	    var casenum = null;
	    try {
		casenum = refpath.match(/\?(\d+)$/i)[1];
	    } catch (e) {}
	    
	    var name = pageName.replace(".pl", ".html");
	    
	    var court = getCourtFromHost(refhost);
	    
	    log("PerlHTMLmeta: " + mimetype + " " + court + 
		" " + name + " " + casenum);

	    return {mimetype: mimetype, court: court,
		    name: name, casenum: casenum };
	}
	
	return false;

    },

    // If this is an interesting doc1 HTML page, return the page's metadata.  
    //   Otherwise, return false.
    tryDocHTMLmeta: function(channel, path, mimetype) {

	if (isDocPath(path)) {

	    var referrer = channel.referrer;
	    try {
		var refhost = referrer.asciiHost;
		var refpath = referrer.path;	   
	    } catch(e) {
		return false;
	    }

	    // doc1 pages whose referrer is also a doc1 shouldn't be uploaded.
	    //   This happens in at least two cases: 
	    //     (1) when 'View Document' is clicked to get a PDF, and 
	    //     (2) when clicking on a subdocument from a disambiguation 
	    //          page-- in this case, the page will be a solo receipt 
	    //          page anyway, so just ignore it.
	    // SS: again maybe we could do #2 more intelligently by looking at POST vars -- also, does this not already get caught because the page isn't a PDF?
	    if (isDocPath(refpath)) {
		return false;
	    }

	    var court = getCourtFromHost(channel.URI.asciiHost);

	    log("DocHTMLmeta: " + mimetype + " " + court + 
		" " + path );

	    return {mimetype: mimetype, court: court,
		    name: path };
	}
	
	return false;

    },

    // Wrap both types of interesting HTML metadata generation.
    tryHTMLmeta: function(channel, path, mimetype) {

	meta = this.tryPerlHTMLmeta(channel, path, mimetype);
	if (meta) {
	    return meta;
	}
	
	meta = this.tryDocHTMLmeta(channel, path, mimetype);
	if (meta) {
	    return meta;
	}

	return false;
    },

    
    fileSuffixFromMime: function(mimetype) {
	if (mimetype == "application/pdf") {
	    return ".pdf";
	} else {
	    return null;
	}
    },

    // Returns the specified Content-type from the HTTP response header
    getMimetype: function(channel) {
        try {
	    return channel.getResponseHeader("Content-Type");
	} catch(e) {
	    return null;
	}
    },

    // Returns true if we should ignore this page from all RECAP modification
    ignorePage: function(path) {
	var ignorePages = ["login.pl", "iquery.pl", "BillingRpt.pl"];
	
	var pageName = this.perlPathMatch(path);

	return (pageName && ignorePages.indexOf(pageName) >= 0) ? true : false;
    },

    // Find the name of the PACER perl script in the path
    perlPathMatch: function(path) {
	var pageName = null;
	try {
	    pageName = path.match(/(\w+)\.pl/i)[0];
	} catch(e) {}

	return pageName;
    },

    // Intercept the channel, and upload the data with metadata
    uploadChannelData: function(subject, metadata) {
	var dlistener = new DownloadListener(metadata);
	subject.QueryInterface(Ci.nsITraceableChannel);
	dlistener.originalListener = subject.setNewListener(dlistener);
    },

    // Called on every HTTP response
    observe: function(subject, topic, data) {
        if (topic != "http-on-examine-response")
            return;



	var channel = subject.QueryInterface(Ci.nsIHttpChannel);
	var URIscheme = channel.URI.scheme;
	var URIhost = channel.URI.asciiHost;
	var URIpath = channel.URI.path;

	// Ignore non-PACER domains, or if no PACER cookie, or some PACER pages
	if (!isPACERHost(URIhost) || !havePACERCookie(channel.URI, channel) || this.ignorePage(URIpath)) {
	    //log("Ignored: " + URIhost + " " + URIpath)
	    return;
	}

	//this.logHeaders(channel);
	this.setCacheFriendlyHeaders(channel);

	var mimetype = this.getMimetype(channel);	

	// Upload content to the server if the file is a PDF
	if (isPDF(mimetype)) {

	    var PDFmeta = this.getPDFmeta(channel, mimetype);

	    // Set Content-Disposition header to be save-friendly
	    this.setContentDispositionHeader(channel, 
					     PDFmeta.name, 
					     PDFmeta.court);

	    this.uploadChannelData(subject, PDFmeta);

	} else if (isHTML(mimetype)) {
	    // Upload content to the server if the file is interesting HTML
	    
	    var HTMLmeta = this.tryHTMLmeta(channel, URIpath, mimetype);

	    if (HTMLmeta) {	    	    
		this.uploadChannelData(subject, HTMLmeta);
	    }
	}
    },

    get _observerService() {
        return CCGS("@mozilla.org/observer-service;1", "nsIObserverService");
    },
    
    _register: function() {
        log("register RequestObserver");
        this._observerService.addObserver(this, 
					  "http-on-examine-response", 
					  false);
    },
    
    unregister: function() {
        log("unregister RequestObserver");
        this._observerService.removeObserver(this, 
					     "http-on-examine-response");
    }
};