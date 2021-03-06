import { shell, ipcMain, webContents, app as browserInstance } from 'electron';
import { CONSTANTS, APP_STATUS, MESSAGES, SAFE_APP_ERROR_CODES } from './constants';
import { fromAuthURI  } from 'safe-app';

import store from './store';
import logInRenderer from '../logInRenderer';
import { getAPI } from './helpers';

const STATE_KEY = CONSTANTS.STATE_KEY;

const appInfo = {
  id: 'net.maidsafe.app.browser',
  name: 'SAFE Browser',
  vendor: 'MaidSafe.net Ltd',
  opts: {
      own_container: true
    },
  permissions :{}
};

let appObj = null;

const safeApp = getAPI('safeApp');
const safeMutableData = getAPI('safeMutableData');
const safeMutableDataEntries = getAPI('safeMutableDataEntries');
const safeMutableDataMutation = getAPI('safeMutableDataMutation');
const safeCrypto = getAPI('safeCrypto');
const safeCryptoPubEncKey = getAPI('safeCryptoPubEncKey');
const safeCryptoKeyPair = getAPI('safeCryptoKeyPair');
const safeCryptoSecEncKey = getAPI('safeCryptoSecEncKey');



// Has to hack via the datastream as that's actually returned by the func,
// not converted to promise as via the RPC.
export const authoriseApp = () => {
  logInRenderer('Authorising app.')
  return new Promise( (resolve, reject ) =>
  {
    appObj = {};
    let dataStream =  safeApp.initialise(appInfo);

    dataStream.on('data', ( datum ) =>
    {
      let handle = datum[0];
      appObj.handle = handle;

      safeApp.authorise( handle, appInfo.permissions, appInfo.opts )
        .then((authUri) => {
          appObj.authUri = authUri;
          return safeApp.connectAuthorised( handle, authUri )
            .then( r => resolve( appObj ) )

        })
    })
  })
};


export const connect = (uri, netStatusCallback) => {
  let registeredApp;
  return fromAuthURI(APP_INFO.info, uri, netStatusCallback)
          .then((app) => registeredApp = app)
          .then(() => saveAuthData(uri))
          .then(() => registeredApp.auth.refreshContainersPermissions())
          .then(() => registeredApp);
}

export const reconnect = (app) => {
  return app.reconnect();
}


/**
 * Adds an encrypted value mutation to an existing mutation handle + key for a given MD.
 * Encrypts both the handle and the key.
 * @param  { String } md      mutableDataHandle
 * @param  { String } mut     mutationHandle
 * @param  { String } key     key to encrypt and store the value as
 * @param  { String } value   String or Buffer to encrypt and store
 * @param  { Int } version   [optional] version of the data if updating (then required)
 * @return { Promise }
 */
const updateOrCreateEncrypted = (mutableDataHandle, mutationHandle, key, value, version) => {
  let encryptedValue;

  return new Promise( (resolve, reject ) =>
  {
    safeMutableData.encryptKey( mutableDataHandle, key )
    .then((encryptedKey) => safeMutableData.encryptValue( mutableDataHandle, value)
    .then( res =>
      {
        encryptedValue = res;

        if( version )
        {
          safeMutableDataMutation.update( mutationHandle, encryptedKey, encryptedValue, version )
            .then( resolve )
        }
        else
        {
          safeMutableDataMutation.insert( mutationHandle, encryptedKey, encryptedValue )
            .then( resolve )
        }
      })
    )
    .catch( e =>
      {
        logInRenderer('Problems updating/inserting encrypted: ', e,  e.message )
        reject( e );
      })

  } )
}


/**
 * Parses the browser state to json (removes initializer) and saves to an MD on the app Homecontainer,
 * encrypting as it goes.
 * @param  { Object } state App state
 * @param  { Bool } quit  to quit or not to quit...
 * @return {[type]}       Promise
 */
export const saveConfigToSafe = ( state, quit ) =>
{
  const stateToSave = { ...state, initializer: {} };
  const JSONToSave = JSON.stringify( stateToSave )
  let encryptedData;
  let encryptedKey;
  let homeMdHandle;

  return new Promise( ( resolve, reject ) =>
  {
  const initializer = state.initializer;
  const app = initializer.app;

  if( !app || !app.handle || !app.authUri )
  {
    logInRenderer("Not authorised to save to the network.")
    console.log("Not authorised to save to the network.")

    if( quit )
    {
      browserInstance.quit();
    }

    return reject( 'Not authorised to save data' );
  }

  logInRenderer("Attempting to save state to the network.")

  safeApp.getOwnContainer( app.handle )
    .then( res => homeMdHandle = res )
    .then( data => encryptedData = data )
    .then( () =>
    {
      let mutationHandle;
      return safeMutableData.getEntries(homeMdHandle)
      .then((entriesHandle) => safeMutableDataEntries.mutate(entriesHandle))
      .then((res) => mutationHandle = res)
      .then( () => safeMutableData.encryptKey( homeMdHandle, STATE_KEY ) )
      .then( res => encryptedKey = res )
      .then( () => safeMutableData.get( homeMdHandle, encryptedKey ) )
      .catch( e => logInRenderer(e.code, e.message))
      .then((value) =>
      {
        let version = null;

        if( value )
        {
          version = value.version + 1
        }

        return updateOrCreateEncrypted( homeMdHandle, mutationHandle, STATE_KEY, JSONToSave, version )
      } )
      .then(_ => safeMutableData.applyEntriesMutation(homeMdHandle, mutationHandle))
      .then( (done) =>
      {
        logInRenderer("Successfully save data to the network.")
        resolve();

        if( quit )
        {
          browserInstance.quit();
        }

        return Promise.resolve();
      } )
    })
    .catch( e =>
      {
        logInRenderer('Problems saving data to the network: ', e.message );
        reject( e );
        if( quit )
        {
          browserInstance.quit();
        }
      })

  })
}

function delay(t) {
   return new Promise(function(resolve) {
       setTimeout(resolve, t)
   });
}

/**
 * Read the configuration from the netowrk
 * @param  {[type]} app SafeApp reference, with handle and authUri
 */
export const readConfig = ( app ) =>
{
  return new Promise( (resolve, reject) =>
  {
    if( !app || !app.handle || !app.authUri )
    {
      reject('Not authorised to read from the network.');
    }

    let homeMdHandle;
    let encryptedKey;
    let encryptedValue;

    safeApp.connectAuthorised( app.handle, app.authUri )
    .then( () =>
    {
      // FIXME: we add a delay here to prevent a deadlock known in the node-ffi
      // logic when dealing with the callbacks.
      // Research and remove this ASAP.
      return delay(5000)
      .then((r) => safeApp.getOwnContainer( app.handle ))
      .then( res => homeMdHandle = res )
      .then( () => safeMutableData.encryptKey( homeMdHandle, STATE_KEY ) )
      .then( res => encryptedKey = res )
      .then( () => safeMutableData.get( homeMdHandle, encryptedKey ) )
      .then( res => encryptedValue = res )
      .then( () => safeMutableData.decrypt( homeMdHandle, encryptedValue.buf ) )
      .then( browserState => JSON.parse( browserState.toString() ) )
      .then( json => {
        logInRenderer("State retrieved: ", json  );
        resolve( json );
      })
      .catch( e =>
        {
          logInRenderer( 'Failure getting config from the network: ', e.message )
          logInRenderer( 'Failure getting config from the network: ', e.stack )
          reject( e );
        })

      })

  })
}
