// This file is added in HW 2
import { Boolean, Optional, Number, String, Literal, Array, Tuple, Record, Union, Static, Template, Partial, Null } from 'runtypes';
const canonicalize = require('canonicalize')
import * as network from './network'
import * as message from './message'
import {Peer} from './peer'
import {validateTx} from './transactions'
import {validateBlock} from './blocks'
import {objectToId} from './utils'
import * as DB from './database'
import {GENESIS_ID, GENESIS_BLOCK} from './constants'

const Outpoint = Record({
	txid: String,
	index: Number
});

export const Hash = String.withConstraint((id) => {
    return /^[a-f0-9]{64}$/.test(id);
});

export const UTXOObjectSchema = Record({
    index: Number.withConstraint((n) => {
        return n >= 0;
    }),
    txid: Hash,
});

export const GeneralTxObject = Record({
    type: Literal('transaction'),
    inputs: Array(Record({
        outpoint: UTXOObjectSchema,
        sig: String.withConstraint((id) => {
            return /^[a-f0-9]{128}$/.test(id);
        }),
    })),
    outputs: Array(Record({
        pubkey: Hash,
        value: Number.withConstraint((n) => {
            return n >= 0;
        }),
    })),
});

export const CoinbaseObject = Record({
    type: Literal('transaction'),
    height: Number.withConstraint((n) => {
        return n >= 0;
    }),
    outputs: Array(Record({
        pubkey: Hash,
        value: Number.withConstraint((n) => {
            return n >= 0;
        }),
    })).withConstraint((outputs) => {
        return outputs.length === 1;
    }),
});

export const BlockObject = Record({
    type: Literal('block'),
    txids: Array(Hash),
    nonce: Hash,
    previd: Hash.Or(Null),
    created: Number,
    T: Literal('00000002af000000000000000000000000000000000000000000000000000000'),
    miner: Optional(String.withConstraint((text) => {
        return text.length <= 128 && /^[\x20-\x7E]*$/.test(text);
    })),
    note: Optional(String.withConstraint((text) => {
        return text.length <= 128 && /^[\x20-\x7E]*$/.test(text);
    })),
});

// Only there in order to have a dummy object type for testing
// Hash = "c90232586b801f9558a76f2f963eccd831d9fe6775e4c8f1446b2331aa2132f2"
const TestObject = Record({
	type: Literal("testobject")
});

export const TxObject = Union(GeneralTxObject, CoinbaseObject);
export const Object = Union(GeneralTxObject, CoinbaseObject, BlockObject, TestObject);

export type GeneralTxObjectType = Static<typeof GeneralTxObject>
export type CoinbaseObjectType = Static<typeof CoinbaseObject>
export type TxObjectType = Static<typeof TxObject>
export type BlockObjectType = Static<typeof BlockObject>
export type ObjectType = Static<typeof Object>

export async function initObjectDB(){
	await DB.put("object:"+GENESIS_ID, canonicalize(GENESIS_BLOCK))
}

export async function clearObjectDB(){
	await DB.clear("object:")
}

export async function getObject(objectid: string){
	if (await doesObjectExist(objectid)){
		const obj = JSON.parse(await DB.get("object:"+objectid));
		return obj;
	}
	else {
		throw "Object not found in database";
	}
}

export async function doesObjectExist(objectid: string){
	return await DB.exists("object:"+objectid)
}

export async function saveObject(objectid: string, object: any){
	await DB.put("object:"+objectid, canonicalize(object))
}

function requestObject(objectid: string, peer:Peer){
	const getObjectMessage = message.encodeMessage({type:"getobject",objectid:objectid});
	console.log("Requesting peer "+peer.name+" for object "+objectid)
	network.sendMessage(getObjectMessage,peer);
}

export async function requestObjectIfNotPresent(objectid: string, peer:Peer){
	if (!(await doesObjectExist(objectid))){
		requestObject(objectid,peer)
	}
	else
		console.log("Object already exists with objectid "+objectid)
}

export function requestAllObject(objectid: string){
	const getObjectMessage = message.encodeMessage({type:"getobject",objectid:objectid});
	console.log("Requesting network for object "+objectid)
	network.broadcastMessage(getObjectMessage);
}

// Function to callback (resolve function) on receiving a certain object
// NOTE: It will send back unvalidated object!
let objectWaiters: {[objectid: string]: {resolve: ((obj: any) => void), reject: ((obj: any) => void)}[]} = {}

export function requestAndWaitForObject(objectid: string, timeout: number){
	return new Promise((resolve,reject) => {
		let firstRequest: boolean
		if(typeof objectWaiters[objectid] === "undefined"){
			firstRequest = true
			objectWaiters[objectid] = [{resolve, reject}]
		} else{
			firstRequest = false
			objectWaiters[objectid].push({resolve, reject})
		}
		setTimeout(() => {
			reject("Object with id "+objectid+" not found in network")
		}, timeout)
		if (firstRequest){
			requestAllObject(objectid)
		}
	})
}

export function advertizeObject(objectid:string, sender?:Peer){
	const iHaveObjectMessage = message.encodeMessage({type:"ihaveobject",objectid:objectid});
	console.log("Gossip I have object "+objectid+" to all peers")
	if (typeof sender === "undefined"){
		network.broadcastMessage(iHaveObjectMessage)
	} else {
		network.broadcastMessageExceptSender(iHaveObjectMessage,sender);
	}
}

export async function receiveObject(object:any, sender?:Peer){
	const objectid = objectToId(object);
	let invalidError = ""
	if (!(await doesObjectExist(objectid))){
		let objectIsValid = false;
		try{
			if (TxObject.guard(object)){
				console.log("Validating transaction "+objectid+"...")
				await validateTx(object)
				console.log("Transaction "+objectid+" is valid")
			} else if (BlockObject.guard(object)){ // This case added in HW 3
				console.log("Validating block "+objectid+"...")
				await validateBlock(object)
				console.log("Block "+objectid+" is valid")
			}
			objectIsValid = true
		} catch(error){
			console.log(error);
			invalidError = error as string
			if (typeof sender !== "undefined"){
				network.reportError(sender, error as string)
			}
		}
		if(objectIsValid){
			// Object is now being saved in the block and transaction validation functions
			// await saveObject(objectid, object);
			advertizeObject(objectid,sender);
		}
		if (typeof objectWaiters[objectid] !== "undefined"){ // Added in HW 3
			if (objectIsValid) {
				let resolves = objectWaiters[objectid].map(waiter => waiter.resolve)
				for (let resolve of resolves){
					resolve(object)
				}
			} else {
				let rejects = objectWaiters[objectid].map(waiter => waiter.reject)
				for (let reject of rejects){
					reject("Object with id "+objectid+" was invalid: "+invalidError)
				}
			}
			delete objectWaiters[objectid]
		}
	} else{
		console.log("Object already exists with objectid "+objectid)
		if (typeof objectWaiters[objectid] !== "undefined"){ // Added in HW 3
			let resolves = objectWaiters[objectid].map(waiter => waiter.resolve)
			for (let resolve of resolves){
				resolve(object)
			}
			delete objectWaiters[objectid]
		}
	}
}

export async function sendObject(objectid:string, peer:Peer){
	try{
		const obj = await getObject(objectid);
		const objectMessage = message.encodeMessage({type:"object",object:obj});
		console.log("Sending object "+objectid+" to peer "+peer.name)
		network.sendMessage(objectMessage,peer);
	} catch(error) {
		throw error;
	}
}
