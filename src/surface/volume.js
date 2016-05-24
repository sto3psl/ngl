/**
 * @file Volume
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */


import { Debug, Log, WorkerRegistry, ColorMakerRegistry, GidPool } from "../globals.js";
import { fromJSON } from "../utils.js";
import WorkerPool from "../worker/worker-pool.js";
import { uniformArray } from "../math/array-utils";
import MarchingCubes from "./marching-cubes.js";
import { laplacianSmooth, computeVertexNormals } from "./surface-utils.js";
import Surface from "./surface.js";


WorkerRegistry.add( "surf", function( e, callback ){

    if( Debug ) Log.time( "WORKER surf" );

    if( self.vol === undefined ) self.vol = new Volume();

    var surface;
    var vol = self.vol;
    var d = e.data;
    var p = d.params;

    if( d.vol ) vol.fromJSON( d.vol );

    if( p ){
        surface = vol.getSurface(
            p.isolevel, p.smooth, p.center, p.size
        );
    }

    if( Debug ) Log.timeEnd( "WORKER surf" );

    if( p ){
        callback( surface.toJSON(), surface.getTransferable() );
    }else{
        callback();
    }

} );


function Volume( name, path, data, nx, ny, nz, dataAtomindex ){

    this.name = name;
    this.path = path;

    this.matrix = new THREE.Matrix4();
    this.normalMatrix = new THREE.Matrix3();
    this.inverseMatrix = new THREE.Matrix4();
    this.center = new THREE.Vector3();
    this.boundingBox = new THREE.Box3();

    this.setData( data, nx, ny, nz, dataAtomindex );

    if( this.__data.length <= Math.pow( 10, 7 ) ){
        GidPool.addObject( this );
    }

}

Volume.prototype = {

    constructor: Volume,
    type: "Volume",

    setData: function( data, nx, ny, nz, dataAtomindex ){

        this.nx = nx || 1;
        this.ny = ny || 1;
        this.nz = nz || 1;

        this.data = data || new Float32Array( 1 );
        this.__data = this.data;

        this.setDataAtomindex( dataAtomindex );

        delete this.mc;

        delete this.__isolevel;
        delete this.__smooth;
        delete this.__minValue;
        delete this.__maxValue;

        delete this.__dataPositionBuffer;
        delete this.__dataPosition;
        delete this.__dataBuffer;

        delete this.__dataMin;
        delete this.__dataMax;
        delete this.__dataMean;
        delete this.__dataRms;

        if( this.worker ) this.worker.terminate();

        if( this.__data.length <= Math.pow( 10, 7 ) ){
            GidPool.updateObject( this, true );
        }else{
            Log.warn( "Volume too large (>10^7), not adding to GidPool" );
            GidPool.removeObject( this );
        }

    },

    setMatrix: function( matrix ){

        this.matrix.copy( matrix );

        var bb = this.boundingBox;
        var v = this.center;  // temporary re-purposing

        var x = this.nx - 1;
        var y = this.ny - 1;
        var z = this.nz - 1;

        bb.makeEmpty();

        bb.expandByPoint( v.set( x, y, z ) );
        bb.expandByPoint( v.set( x, y, 0 ) );
        bb.expandByPoint( v.set( x, 0, z ) );
        bb.expandByPoint( v.set( x, 0, 0 ) );
        bb.expandByPoint( v.set( 0, y, z ) );
        bb.expandByPoint( v.set( 0, 0, z ) );
        bb.expandByPoint( v.set( 0, y, 0 ) );
        bb.expandByPoint( v.set( 0, 0, 0 ) );

        bb.applyMatrix4( this.matrix );
        bb.center( this.center );

        // make normal matrix

        var me = this.matrix.elements;
        var r0 = new THREE.Vector3( me[0], me[1], me[2] );
        var r1 = new THREE.Vector3( me[4], me[5], me[6] );
        var r2 = new THREE.Vector3( me[8], me[9], me[10] );
        var cp = new THREE.Vector3();
        //        [ r0 ]       [ r1 x r2 ]
        // M3x3 = [ r1 ]   N = [ r2 x r0 ]
        //        [ r2 ]       [ r0 x r1 ]
        var ne = this.normalMatrix.elements;
        cp.crossVectors( r1, r2 );
        ne[ 0 ] = cp.x;
        ne[ 1 ] = cp.y;
        ne[ 2 ] = cp.z;
        cp.crossVectors( r2, r0 );
        ne[ 3 ] = cp.x;
        ne[ 4 ] = cp.y;
        ne[ 5 ] = cp.z;
        cp.crossVectors( r0, r1 );
        ne[ 6 ] = cp.x;
        ne[ 7 ] = cp.y;
        ne[ 8 ] = cp.z;

        this.inverseMatrix.getInverse( this.matrix );

    },

    setDataAtomindex: function( dataAtomindex ){

        this.dataAtomindex = dataAtomindex;
        this.__dataAtomindex = this.dataAtomindex;

        delete this.__dataAtomindexBuffer;

    },

    getBox: function( center, size, target ){

        if( !target ) target = new THREE.Box3();

        target.set( center, center );
        target.expandByScalar( size );
        target.applyMatrix4( this.inverseMatrix );

        target.min.round();
        target.max.round();

        return target;

    },

    getSurface: function( isolevel, smooth, center, size ){

        isolevel = isNaN( isolevel ) ? this.getValueForSigma( 2 ) : isolevel;
        smooth = smooth || 0;
        center = center;
        size = size;

        //

        if( this.mc === undefined ){

            this.mc = new MarchingCubes(
                this.__data, this.nx, this.ny, this.nz, this.__dataAtomindex
            );

        }

        var box;

        if( center && size ){

            if( !this.__box ) this.__box = new THREE.Box3();
            this.getBox( center, size, this.__box );
            box = [ this.__box.min.toArray(), this.__box.max.toArray() ];

        }

        var sd;

        if( smooth ){

            sd = this.mc.triangulate( isolevel, true, box );
            laplacianSmooth( sd.position, sd.index, smooth, true );

            var bg = new THREE.BufferGeometry();
            bg.addAttribute( "position", new THREE.BufferAttribute( sd.position, 3 ) );
            bg.setIndex( new THREE.BufferAttribute( sd.index, 1 ) );
            bg.computeVertexNormals();
            sd.normal = bg.attributes.normal.array;
            bg.dispose();

        }else{

            sd = this.mc.triangulate( isolevel, false, box );

        }

        this.matrix.applyToVector3Array( sd.position );

        if( sd.normal ){

            this.normalMatrix.applyToVector3Array( sd.normal );

        }

        var surface = new Surface( "", "", sd );
        surface.info.isolevel = isolevel;
        surface.info.smooth = smooth;

        return surface;

    },

    getSurfaceWorker: function( isolevel, smooth, center, size, callback ){

        isolevel = isNaN( isolevel ) ? this.getValueForSigma( 2 ) : isolevel;
        smooth = smooth || 0;

        //

        if( typeof Worker !== "undefined" && typeof importScripts !== 'function' ){

            if( this.workerPool === undefined ){
                this.workerPool = new WorkerPool( "surf", 2 );
            }

            var worker = this.workerPool.getNextWorker();

            worker.post(

                {
                    vol: worker.postCount === 0 ? this.toJSON() : null,
                    params: {
                        isolevel: isolevel,
                        smooth: smooth,
                        center: center,
                        size: size
                    }
                },

                undefined,

                function( e ){

                    var surface = fromJSON( e.data );
                    callback( surface );

                },

                function( e ){

                    console.warn(
                        "Volume.generateSurfaceWorker error - trying without worker", e
                    );

                    var surface = this.getSurface( isolevel, smooth, center, size );
                    callback( surface );

                }.bind( this )

            );

        }else{

            var surface = this.getSurface( isolevel, smooth, center, size );
            callback( surface );

        }

    },

    getValueForSigma: function( sigma ){

        sigma = sigma !== undefined ? sigma : 2;

        return this.getDataMean() + sigma * this.getDataRms();

    },

    getSigmaForValue: function( value ){

        value = value !== undefined ? value : 0;

        return ( value - this.getDataMean() ) / this.getDataRms();

    },

    filterData: function( minValue, maxValue, outside ){

        if( isNaN( minValue ) && this.header ){
            minValue = this.header.DMEAN + 2.0 * this.header.ARMS;
        }

        minValue = ( minValue !== undefined && !isNaN( minValue ) ) ? minValue : -Infinity;
        maxValue = maxValue !== undefined ? maxValue : Infinity;
        outside = outside || false;

        if( !this.dataPosition ){

            this.makeDataPosition();

        }

        var dataPosition = this.__dataPosition;
        var data = this.__data;

        if( minValue === this.__minValue && maxValue == this.__maxValue &&
            outside === this.__outside
        ){

            // already filtered
            return;

        }else if( minValue === -Infinity && maxValue === Infinity ){

            this.dataPosition = dataPosition;
            this.data = data;

        }else{

            var n = data.length;

            if( !this.__dataBuffer ){

                // ArrayBuffer for re-use as Float32Array backend

                this.__dataPositionBuffer = new ArrayBuffer( n * 3 * 4 );
                this.__dataBuffer = new ArrayBuffer( n * 4 );

            }

            var filteredDataPosition = new Float32Array( this.__dataPositionBuffer );
            var filteredData = new Float32Array( this.__dataBuffer );

            var j = 0;

            for( var i = 0; i < n; ++i ){

                var i3 = i * 3;
                var v = data[ i ];

                if( ( !outside && v >= minValue && v <= maxValue ) ||
                    ( outside && ( v < minValue || v > maxValue ) )
                ){

                    var j3 = j * 3;

                    filteredDataPosition[ j3 + 0 ] = dataPosition[ i3 + 0 ];
                    filteredDataPosition[ j3 + 1 ] = dataPosition[ i3 + 1 ];
                    filteredDataPosition[ j3 + 2 ] = dataPosition[ i3 + 2 ];

                    filteredData[ j ] = v;

                    j += 1;

                }

            }

            // set views

            this.dataPosition = new Float32Array( this.__dataPositionBuffer, 0, j * 3 );
            this.data = new Float32Array( this.__dataBuffer, 0, j );

        }

        this.__minValue = minValue;
        this.__maxValue = maxValue;
        this.__outside = outside;

    },

    makeDataPosition: function(){

        var nz = this.nz;
        var ny = this.ny;
        var nx = this.nx;

        var position = new Float32Array( nx * ny * nz * 3 );

        var p = 0;

        for( var z = 0; z < nz; ++z ){

            for( var y = 0; y < ny; ++y ){

                for( var x = 0; x < nx; ++x ){

                    position[ p + 0 ] = x;
                    position[ p + 1 ] = y;
                    position[ p + 2 ] = z;

                    p += 3;

                }

            }

        }

        this.matrix.applyToVector3Array( position );

        this.dataPosition = position;
        this.__dataPosition = position;

    },

    getDataAtomindex: function(){

        return this.dataAtomindex;

    },

    getDataPosition: function(){

        return this.dataPosition;

    },

    getDataColor: function( params ){

        var p = params || {};
        p.volume = this;
        p.scale = p.scale || 'Spectral';
        p.domain = p.domain || [ this.getDataMin(), this.getDataMax() ];

        var colorMaker = ColorMakerRegistry.getScheme( p );

        var n = this.dataPosition.length / 3;
        var array = new Float32Array( n * 3 );

        // var atoms = p.structure.atoms;
        // var atomindex = this.dataAtomindex;

        for( var i = 0; i < n; ++i ){

            colorMaker.volumeColorToArray( i, array, i * 3 );

            // a = atoms[ atomindex[ i ] ];
            // if( a ) colorMaker.atomColorToArray( a, array, i * 3 );

        }

        return array;

    },

    getPickingDataColor: function( params ){

        var p = Object.assign( params || {} );
        p.scheme = "picking";

        return this.getDataColor( p );

    },

    getDataSize: function( size, scale ){

        var n = this.dataPosition.length / 3;
        var i, array;

        switch( size ){

            case "value":

                array = new Float32Array( this.data );
                break;

            case "abs-value":

                array = new Float32Array( this.data );
                for( i = 0; i < n; ++i ){
                    array[ i ] = Math.abs( array[ i ] );
                }
                break;

            case "value-min":

                array = new Float32Array( this.data );
                var min = this.getDataMin();
                for( i = 0; i < n; ++i ){
                    array[ i ] -= min;
                }
                break;

            case "deviation":

                array = new Float32Array( this.data );
                break;

            default:

                array = uniformArray( n, size );
                break;

        }

        if( scale !== 1.0 ){

            for( i = 0; i < n; ++i ){
                array[ i ] *= scale;
            }

        }

        return array;

    },

    getDataMin: function(){

        if( this.__dataMin === undefined ){

            var data = this.__data;
            var n = data.length;
            var min = Infinity;

            for( var i = 0; i < n; ++i ){
                min = Math.min( min, data[ i ] );
            }

            this.__dataMin = min;

        }

        return this.__dataMin;

    },

    getDataMax: function(){

        if( this.__dataMax === undefined ){

            var data = this.__data;
            var n = data.length;
            var max = -Infinity;

            for( var i = 0; i < n; ++i ){
                max = Math.max( max, data[ i ] );
            }

            this.__dataMax = max;

        }

        return this.__dataMax;

    },

    getDataMean: function(){

        if( this.__dataMean === undefined ){

            var data = this.__data;
            var n = data.length;
            var sum = 0;

            for( var i = 0; i < n; ++i ){
                sum += data[ i ];
            }

            this.__dataMean = sum / n;

        }

        return this.__dataMean;

    },

    getDataRms: function(){

        if( this.__dataRms === undefined ){

            var data = this.__data;
            var n = data.length;
            var sumSq = 0;
            var di, i;

            for( i = 0; i < n; ++i ){
                di = data[ i ];
                sumSq += di * di;
            }

            this.__dataRms = Math.sqrt( sumSq / n );

        }

        return this.__dataRms;

    },

    clone: function(){

        var vol = new Volume(

            this.name,
            this.path,

            this.__data,

            this.nx,
            this.ny,
            this.nz,

            this.__dataAtomindex

        );

        vol.matrix.copy( this.matrix );

        if( this.header ){

            vol.header = Object.assign( {}, this.header );

        }

        return vol;

    },

    toJSON: function(){

        var output = {

            metadata: {
                version: 0.1,
                type: 'Volume',
                generator: 'VolumeExporter'
            },

            name: this.name,
            path: this.path,

            data: this.__data,

            nx: this.nx,
            ny: this.ny,
            nz: this.nz,

            dataAtomindex: this.__dataAtomindex,

            matrix: this.matrix.toArray(),
            normalMatrix: this.normalMatrix.toArray(),
            inverseMatrix: this.inverseMatrix.toArray(),

            center: this.center.toArray(),
            boundingBox: {
                min: this.boundingBox.min.toArray(),
                max: this.boundingBox.max.toArray()
            }

        };

        if( this.header ){

            output.header = Object.assign( {}, this.header );

        }

        return output;

    },

    fromJSON: function( input ){

        this.name = input.name;
        this.path = input.path;

        this.setData(

            input.data,

            input.nx,
            input.ny,
            input.nz,

            input.dataAtomindex

        );

        this.matrix.fromArray( input.matrix );
        this.normalMatrix.fromArray( input.normalMatrix );
        this.inverseMatrix.fromArray( input.inverseMatrix );

        if( input.header ){

            this.header = Object.assign( {}, input.header );

        }

        this.center.fromArray( input.center );
        this.boundingBox.set(
            input.boundingBox.min,
            input.boundingBox.max
        );

        return this;

    },

    getTransferable: function(){

        var transferable = [

            this.__data.buffer

        ];

        if( this.__dataAtomindex ){
            transferable.push( this.__dataAtomindex.buffer );
        }

        return transferable;

    },

    dispose: function(){

        if( this.workerPool ) this.workerPool.terminate();

        GidPool.removeObject( this );

    }

};


export default Volume;