(function() {
    'use strict';
    const w = window;
    const noopfn = function() {
        ; // jshint ignore:line
    }.bind();
    const _Q = w.apstag && w.apstag._Q || [];
    const apstag = {
        _Q,
        fetchBids: function(a, b) {
            if ( typeof b === 'function' ) {
                b([]);
            }
        },
        init: noopfn,
        setDisplayBids: noopfn,
        targetingKeys: noopfn,
    };
    w.apstag = apstag;
    _Q.push = function(prefix, args) {
        try {
            switch (prefix) {
            case 'f':
                apstag.fetchBids(...args);
                break;
            }
        } catch (e) {
            console.trace(e);
        }
    };
    for ( const cmd of _Q ) {
        _Q.push(cmd);
    }
})();
